import type { Config } from './config.js';
import { SubmitFailedError, SubmitUncertainError } from './cups-client.js';
import { MessageStore } from './store.js';
import type { IncomingMessage, PrinterSubmitter, ProcessingResult, StoredMessage } from './types.js';
import { ValidationError, validateFile } from './validation.js';

function duplicateReply(message: StoredMessage): ProcessingResult {
  const previous = message.result ?? '已接收，处理中';
  return { status: message.status, reply: `该消息已处理：${previous}` };
}

function displayJobId(jobId: string | number): string {
  return /\/jobs\/(\d+)$/.exec(String(jobId))?.[1] ?? String(jobId);
}

export class PrintGateway {
  constructor(private readonly config: Config, private readonly store: MessageStore, private readonly printer: PrinterSubmitter) {}

  async process(message: IncomingMessage): Promise<ProcessingResult> {
    const reserved = this.store.reserve(message.msgId, message.userId);
    if (!reserved.created) return duplicateReply(reserved.message);
    if (!this.config.allowedExternalUsers.has(message.userId)) return this.reject(message.msgId, '无打印权限，请联系管理员开通白名单');
    if (this.store.countRecentForUser(message.userId, Date.now() - this.config.rateLimitWindowMs) > this.config.rateLimitCount) return this.reject(message.msgId, '请求过于频繁，请稍后再试');

    try {
      this.store.transition(message.msgId, 'downloading');
      const files = await message.loadFiles();
      if (!files.length) return this.reject(message.msgId, '未找到可打印内容');
      this.store.transition(message.msgId, 'validating');
      const validated = files.map((file) => validateFile(file, this.config.maxFileBytes, this.config.maxPages));
      this.store.transition(message.msgId, 'submitting');
      const receipts = [];
      for (const file of validated) receipts.push({ ...await this.printer.submit(file), filename: file.filename });
      const description = receipts.map((item) => `${displayJobId(item.jobId)}${item.pages === undefined ? '' : `（${item.pages} 页）`}`).join('、');
      const reply = `已提交 CUPS 打印任务 ${description}。该状态仅表示任务已被接收，不代表已经出纸。`;
      this.store.transition(message.msgId, 'accepted', reply);
      return { status: 'accepted', reply, receipts };
    } catch (error) {
      if (error instanceof SubmitUncertainError) {
        const reply = '提交状态未知，请查看打印机或 cups-web 管理后台；系统不会自动重发，以免重复出纸。';
        this.store.transition(message.msgId, 'uncertain', reply);
        return { status: 'uncertain', reply };
      }
      const detail = error instanceof ValidationError || error instanceof SubmitFailedError ? error.message : '内部处理失败';
      return this.reject(message.msgId, `未提交打印：${detail}`);
    }
  }

  private reject(msgId: string, reply: string): ProcessingResult {
    this.store.transition(msgId, 'rejected', reply);
    return { status: 'rejected', reply };
  }
}
