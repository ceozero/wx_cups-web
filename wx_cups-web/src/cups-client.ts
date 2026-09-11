import axios, { AxiosError } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import FormData from 'form-data';
import { CookieJar } from 'tough-cookie';
import type { Config } from './config.js';
import type { PrintableFile, PrintReceipt, PrinterSubmitter } from './types.js';

export class SubmitUncertainError extends Error {}
export class SubmitFailedError extends Error {}

export class CupsWebClient implements PrinterSubmitter {
  private readonly jar = new CookieJar();
  private readonly http;
  private loginInFlight?: Promise<void>;

  constructor(private readonly config: Config) {
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

  private async login(): Promise<void> {
    if (!this.loginInFlight) this.loginInFlight = this.doLogin().catch((error) => { this.loginInFlight = undefined; throw error; });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const response = await this.http.post('/api/login', { username: this.config.cupsWebUser, password: this.config.cupsWebPassword });
    if (response.status < 200 || response.status >= 300) throw new SubmitFailedError(`cups-web 登录失败（HTTP ${response.status}）`);
  }
}
