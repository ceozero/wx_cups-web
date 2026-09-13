import { createHash } from 'node:crypto';
import axios from 'axios';
import type { Config } from './config.js';
import type { PrintableFile } from './types.js';
import { mediaMetadata } from './validation.js';

const API_BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin';
const TRANSIENT_API_ERRORS = new Set([-1, 40001, 40014, 42001, 45009]);

export interface KfMessage {
  msgid: string;
  external_userid?: string;
  open_kfid: string;
  /** 3=微信客户消息，4=系统事件，5=企业微信接待人员消息。 */
  origin?: number;
  msgtype: string;
  text?: { content?: string; menu_id?: string };
  image?: { media_id?: string };
  file?: { media_id?: string };
}

interface ApiResponse {
  errcode: number;
  errmsg: string;
}

class WecomApiError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function apiError(operation: string, body: ApiResponse): WecomApiError {
  return new WecomApiError(`${operation}失败（errcode=${body.errcode}，errmsg=${body.errmsg}）`, TRANSIENT_API_ERRORS.has(body.errcode));
}

function filenameFromHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return /filename="?([^";]+)"?/i.exec(value)?.[1];
}

/** 微信客服 msgid 最多 32 字节；相同业务回复使用同一 ID，网络重试不会重复发消息。 */
export function stableWecomMessageId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export function isRetryableWecomError(error: unknown): boolean {
  if (error instanceof WecomApiError) return error.retryable;
  if (!axios.isAxiosError(error)) return false;
  if (!error.response) return true; // DNS、握手、连接中断、Axios timeout。
  return error.response.status === 408 || error.response.status === 429 || error.response.status >= 500;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class WecomKfClient {
  private accessToken?: { value: string; expiresAt: number };
  private accessTokenInFlight?: Promise<string>;

  constructor(private readonly config: Config) {}

  async syncMessages(openKfId: string, callbackToken: string, cursor?: string): Promise<{ messages: KfMessage[]; nextCursor?: string; hasMore: boolean }> {
    const body = await this.post<{ msg_list?: KfMessage[]; next_cursor?: string; has_more?: 0 | 1 }>('kf/sync_msg', {
      open_kfid: openKfId,
      token: callbackToken,
      cursor,
      limit: 1000,
    });
    return { messages: body.msg_list ?? [], nextCursor: body.next_cursor, hasMore: body.has_more === 1 };
  }

  async sendText(openKfId: string, externalUserId: string, content: string, messageKey: string): Promise<void> {
    await this.post('kf/send_msg', {
      touser: externalUserId,
      open_kfid: openKfId,
      msgid: stableWecomMessageId(`text:${messageKey}:${content}`),
      msgtype: 'text',
      text: { content: content.slice(0, 2048) },
    });
  }

  async sendPrintConfirmationMenu(openKfId: string, externalUserId: string, confirmId: string, cancelId: string, messageKey: string): Promise<void> {
    await this.post('kf/send_msg', {
      touser: externalUserId,
      open_kfid: openKfId,
      msgid: stableWecomMessageId(`menu:${messageKey}`),
      msgtype: 'msgmenu',
      msgmenu: {
        head_content: '已收到打印内容，请确认是否打印：',
        list: [
          { type: 'click', click: { id: confirmId, content: '确认打印' } },
          { type: 'click', click: { id: cancelId, content: '取消' } },
        ],
      },
    });
  }

  async downloadMedia(mediaId: string, type: 'image' | 'file'): Promise<PrintableFile> {
    const response = await this.withRetry('企业微信媒体下载', async () => {
      const accessToken = await this.getAccessToken();
      const result = await axios.get<ArrayBuffer>(`${API_BASE_URL}/media/get`, {
        params: { access_token: accessToken, media_id: mediaId },
        responseType: 'arraybuffer',
        timeout: this.config.requestTimeoutMs,
        maxContentLength: this.config.maxFileBytes,
        validateStatus: () => true,
      });
      if (result.status < 200 || result.status >= 300) {
        throw new WecomApiError(`企业微信媒体下载失败（HTTP ${result.status}）`, result.status === 408 || result.status === 429 || result.status >= 500);
      }
      return result;
    });
    const buffer = Buffer.from(response.data);
    const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
    if (contentType.includes('application/json')) {
      const body = JSON.parse(buffer.toString('utf8')) as ApiResponse;
      throw apiError('企业微信媒体下载', body);
    }
    const metadata = mediaMetadata(buffer, filenameFromHeader(response.headers['content-disposition']), type);
    return { ...metadata, buffer };
  }

  private async post<T extends Record<string, unknown> = Record<string, never>>(path: string, payload: Record<string, unknown>): Promise<T> {
    return this.withRetry(`企业微信接口 ${path}`, async () => {
      const accessToken = await this.getAccessToken();
      const response = await axios.post<T & ApiResponse>(`${API_BASE_URL}/${path}`, payload, {
        params: { access_token: accessToken },
        timeout: this.config.requestTimeoutMs,
      });
      if (response.data.errcode !== 0) {
        if ([40001, 40014, 42001].includes(response.data.errcode)) this.accessToken = undefined;
        throw apiError(`企业微信接口 ${path}`, response.data);
      }
      return response.data;
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.value;
    if (!this.accessTokenInFlight) {
      this.accessTokenInFlight = this.withRetry('获取微信客服 access_token', async () => {
        const response = await axios.get<ApiResponse & { access_token?: string; expires_in?: number }>(`${API_BASE_URL}/gettoken`, {
          params: { corpid: this.config.wecomCorpId, corpsecret: this.config.wecomKfSecret },
          timeout: this.config.requestTimeoutMs,
        });
        if (response.data.errcode !== 0 || !response.data.access_token || !response.data.expires_in) throw apiError('获取微信客服 access_token', response.data);
        this.accessToken = { value: response.data.access_token, expiresAt: Date.now() + (response.data.expires_in - 120) * 1000 };
        return this.accessToken.value;
      }).finally(() => { this.accessTokenInFlight = undefined; });
    }
    return this.accessTokenInFlight;
  }

  private async withRetry<T>(operation: string, request: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await request();
      } catch (error) {
        if (!isRetryableWecomError(error) || retry >= this.config.wecomApiMaxRetries) throw error;
        const delayMs = this.config.wecomApiRetryBaseMs * 2 ** retry;
        console.warn(JSON.stringify({ level: 'warn', event: 'wecom_api_retry', operation, attempt: retry + 1, delayMs, error: error instanceof Error ? error.message : 'unknown' }));
        await sleep(delayMs);
      }
    }
  }
}
