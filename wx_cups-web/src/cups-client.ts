import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import type { Config } from './config.js';
import type { CupsWebPrintRecord, PrintHistoryReader, PrintableFile, PrintReceipt, PrinterSubmitter } from './types.js';

export class SubmitUncertainError extends Error {}
export class SubmitFailedError extends Error {}

class CupsWebSession {
  private readonly http;

  constructor(private readonly config: Config, apiKey: string) {
    this.http = axios.create({
      baseURL: config.cupsWebUrl,
      timeout: config.requestTimeoutMs,
      validateStatus: () => true,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  }

  async submit(file: PrintableFile): Promise<PrintReceipt> {
    const form = new FormData();
    form.append('file', file.buffer, { filename: file.filename, contentType: file.contentType });
    form.append('printer', this.config.printerUri);
    form.append('duplex', 'false'); form.append('color', 'false'); form.append('copies', '1');
    form.append('paper_size', 'A4'); form.append('print_scaling', 'auto');
    try {
      const response = await this.http.post('/api/print', form, { headers: form.getHeaders() });
      if (response.status >= 200 && response.status < 300 && response.data?.ok !== false && response.data?.jobId !== undefined) {
        return { jobId: response.data.jobId, pages: response.data.pages };
      }
      if (response.status === 401 || response.status === 403) throw new SubmitFailedError('cups-web API Key 无效、已过期、已撤销或权限不足');
      if (response.status >= 500) throw new SubmitUncertainError(`cups-web 返回 ${response.status}`);
      throw new SubmitFailedError(`cups-web 拒绝打印请求（HTTP ${response.status}）`);
    } catch (error) {
      if (error instanceof SubmitUncertainError || error instanceof SubmitFailedError) throw error;
      const axiosError = error as AxiosError;
      if (!axiosError.response) throw new SubmitUncertainError('提交连接中断或超时，作业状态未知');
      throw new SubmitFailedError('提交打印请求失败');
    }
  }

  async listPrintRecords(limit: number): Promise<CupsWebPrintRecord[]> {
    const response = await this.http.get<unknown>('/api/print-records');
    if (response.status === 401 || response.status === 403) {
      throw new SubmitFailedError('cups-web API Key 无效、已过期、已撤销或权限不足');
    }
    if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data)) {
      throw new SubmitFailedError(`cups-web 查询打印记录失败（HTTP ${response.status}）`);
    }
    return response.data
      .filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === 'object')
      .map((record) => ({
        filename: typeof record.filename === 'string' ? record.filename : '未知文件',
        jobId: typeof record.jobId === 'string' ? record.jobId : '',
        pages: typeof record.pages === 'number' && Number.isFinite(record.pages) ? record.pages : 0,
        status: typeof record.status === 'string' ? record.status : 'unknown',
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      }))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit);
  }
}

/** 每位微信用户使用其 cups-web 用户签发的 API Key，记录和 CUPS 作业归属天然隔离。 */
export class CupsWebClient implements PrinterSubmitter, PrintHistoryReader {
  private readonly sessions = new Map<string, CupsWebSession>();

  constructor(private readonly config: Config) {}

  submit(file: PrintableFile, userId: string): Promise<PrintReceipt> {
    return this.sessionFor(userId).submit(file);
  }

  listPrintRecords(userId: string, limit = 5): Promise<CupsWebPrintRecord[]> {
    return this.sessionFor(userId).listPrintRecords(limit);
  }

  private sessionFor(userId: string): CupsWebSession {
    const apiKey = this.config.cupsApiKeysByExternalUser.get(userId);
    if (!apiKey) throw new SubmitFailedError('未配置该微信用户对应的 cups-web API Key');
    let session = this.sessions.get(userId);
    if (!session) {
      session = new CupsWebSession(this.config, apiKey);
      this.sessions.set(userId, session);
    }
    return session;
  }
}
