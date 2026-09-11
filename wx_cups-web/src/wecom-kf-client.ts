import axios from 'axios';
import type { Config } from './config.js';
import type { PrintableFile } from './types.js';
import { mediaMetadata } from './validation.js';

const API_BASE_URL = 'https://qyapi.weixin.qq.com/cgi-bin';

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

function apiError(operation: string, body: ApiResponse): Error {
  return new Error(`${operation}失败（errcode=${body.errcode}，errmsg=${body.errmsg}）`);
}

function filenameFromHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (utf8) return decodeURIComponent(utf8);
  return /filename="?([^";]+)"?/i.exec(value)?.[1];
}

export class WecomKfClient {
  private accessToken?: { value: string; expiresAt: number };

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

  async sendText(openKfId: string, externalUserId: string, content: string): Promise<void> {
    await this.post('kf/send_msg', {
      touser: externalUserId,
      open_kfid: openKfId,
      msgtype: 'text',
      text: { content: content.slice(0, 2048) },
    });
  }

  async sendPrintConfirmationMenu(openKfId: string, externalUserId: string, confirmId: string, cancelId: string): Promise<void> {
    await this.post('kf/send_msg', {
      touser: externalUserId,
      open_kfid: openKfId,
      msgtype: 'msgmenu',
      msgmenu: {
        head_content: '已收到打印内容。请确认是否提交打印：',
        list: [
          { type: 'click', click: { id: confirmId, content: '确认打印' } },
          { type: 'click', click: { id: cancelId, content: '取消' } },
        ],
      },
    });
  }

  async downloadMedia(mediaId: string, type: 'image' | 'file'): Promise<PrintableFile> {
    const accessToken = await this.getAccessToken();
    const response = await axios.get<ArrayBuffer>(`${API_BASE_URL}/media/get`, {
      params: { access_token: accessToken, media_id: mediaId },
      responseType: 'arraybuffer',
      timeout: this.config.requestTimeoutMs,
      maxContentLength: this.config.maxFileBytes,
      validateStatus: () => true,
    });
    const buffer = Buffer.from(response.data);
    if (response.status < 200 || response.status >= 300) throw new Error('企业微信媒体下载失败');
    const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
    if (contentType.includes('application/json')) {
      const body = JSON.parse(buffer.toString('utf8')) as ApiResponse;
      throw apiError('企业微信媒体下载', body);
    }
    const metadata = mediaMetadata(buffer, filenameFromHeader(response.headers['content-disposition']), type);
    return { ...metadata, buffer };
  }

  private async post<T extends Record<string, unknown> = Record<string, never>>(path: string, payload: Record<string, unknown>): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await axios.post<T & ApiResponse>(`${API_BASE_URL}/${path}`, payload, {
      params: { access_token: accessToken },
      timeout: this.config.requestTimeoutMs,
    });
    if (response.data.errcode !== 0) throw apiError(`企业微信接口 ${path}`, response.data);
    return response.data;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.value;
    const response = await axios.get<ApiResponse & { access_token?: string; expires_in?: number }>(`${API_BASE_URL}/gettoken`, {
      params: { corpid: this.config.wecomCorpId, corpsecret: this.config.wecomKfSecret },
      timeout: this.config.requestTimeoutMs,
    });
    if (response.data.errcode !== 0 || !response.data.access_token || !response.data.expires_in) throw apiError('获取微信客服 access_token', response.data);
    this.accessToken = { value: response.data.access_token, expiresAt: Date.now() + (response.data.expires_in - 120) * 1000 };
    return this.accessToken.value;
  }
}
