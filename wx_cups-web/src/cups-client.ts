import axios, { AxiosError } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import FormData from 'form-data';
import { CookieJar } from 'tough-cookie';
import type { Config, CupsWebCredentials } from './config.js';
import type { CupsWebPrintRecord, PrintHistoryReader, PrintableFile, PrintReceipt, PrinterSubmitter } from './types.js';

export class SubmitUncertainError extends Error {}
export class SubmitFailedError extends Error {}

class CupsWebSession {
  private readonly jar = new CookieJar();
  private readonly http;
  private loginInFlight?: Promise<void>;

  constructor(private readonly config: Config, private readonly credentials: CupsWebCredentials) {
    this.http = wrapper(axios.create({ baseURL: config.cupsWebUrl, jar: this.jar, timeout: config.requestTimeoutMs, validateStatus: () => true }));
  }

  async submit(file: PrintableFile): Promise<PrintReceipt> {
    await this.login();
    const csrf = (await this.jar.getCookies(this.config.cupsWebUrl)).find((cookie) => cookie.key === 'csrf_token')?.value;
    if (!csrf) throw new SubmitFailedError('cups-web 登录未返回 CSRF Token');
    const form = new FormData();
    form.append('file', file.buffer, { filename: file.filename, contentType: file.contentType });
    form.append('printer', this.config.printerUri);
    form.append('duplex', 'false'); form.append('color', 'false'); form.append('copies', '1');
    form.append('paper_size', 'A4'); form.append('print_scaling', 'auto');
    try {
      const response = await this.http.post('/api/print', form, { headers: { ...form.getHeaders(), 'X-CSRF-Token': csrf } });
      if (response.status >= 200 && response.status < 300 && response.data?.ok !== false && response.data?.jobId !== undefined) {
        return { jobId: response.data.jobId, pages: response.data.pages };
      }
      if (response.status === 401 || response.status === 403) this.loginInFlight = undefined;
      if (response.status >= 500) throw new SubmitUncertainError(`cups-web 返回 ${response.status}`);
      throw new SubmitFailedError(`cups-web 拒绝打印请求（HTTP ${response.status}）`);
    } catch (error) {
      if (error instanceof SubmitUncertainError || error instanceof SubmitFailedError) throw error;
      const axiosError = error as AxiosError;
      if (!axiosError.response) throw new SubmitUncertainError('提交连接中断或超时，作业状态未知');
      throw new SubmitFailedError('提交打印请求失败');
    }
  }

  async listPrintRecords(limit: number, retried = false): Promise<CupsWebPrintRecord[]> {
    await this.login();
    const response = await this.http.get<unknown>('/api/print-records');
    if (!retried && (response.status === 401 || response.status === 403)) {
      this.loginInFlight = undefined;
      await this.login();
      return this.listPrintRecords(limit, true);
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

  private async login(): Promise<void> {
    if (!this.loginInFlight) this.loginInFlight = this.doLogin().catch((error) => { this.loginInFlight = undefined; throw error; });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const response = await this.http.post('/api/login', { username: this.credentials.username, password: this.credentials.password });
    if (response.status < 200 || response.status >= 300) throw new SubmitFailedError(`cups-web 登录失败（HTTP ${response.status}）`);
  }
}

/** 每个 cups-web 用户使用独立 Cookie Jar，避免登录态交叉导致历史记录归属错误。 */
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
    const credentials = this.config.cupsCredentialsByExternalUser.get(userId);
    if (!credentials) throw new SubmitFailedError('未配置该微信用户对应的 cups-web 凭据');
    let session = this.sessions.get(userId);
    if (!session) {
      session = new CupsWebSession(this.config, credentials);
      this.sessions.set(userId, session);
    }
    return session;
  }
}
