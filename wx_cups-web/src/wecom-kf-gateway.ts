import type { Config } from './config.js';
import { PrintGateway } from './gateway.js';
import { MessageStore } from './store.js';
import type { IncomingMessage, PrintableFile } from './types.js';
import { WecomKfClient, type KfMessage } from './wecom-kf-client.js';

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

/** 企业微信客服回调只负责唤醒；具体消息由 sync_msg 拉取。 */
export class WecomKfGateway {
  private readonly syncInFlight = new Map<string, Promise<void>>();
  private readonly pendingCallbackTokens = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly store: MessageStore,
    private readonly printGateway: PrintGateway,
    private readonly kf: WecomKfClient,
  ) {}

  syncFromCallback(openKfId: string, callbackToken: string): Promise<void> {
    // 同一客服帐号可能在一次打印尚未结束时收到下一条回调。
    // 保存最新 Token，当前同步结束后再拉取一次，不能直接丢弃该唤醒信号。
    this.pendingCallbackTokens.set(openKfId, callbackToken);
    const existing = this.syncInFlight.get(openKfId);
    if (existing) return existing;
    const task = this.drainSync(openKfId).catch((error) => {
      console.error(JSON.stringify({ level: 'error', event: 'wecom_kf_sync_failed', openKfId, error: errorDetail(error) }));
    }).finally(() => this.syncInFlight.delete(openKfId));
    this.syncInFlight.set(openKfId, task);
    return task;
  }

  private async drainSync(openKfId: string): Promise<void> {
    while (this.pendingCallbackTokens.has(openKfId)) {
      const callbackToken = this.pendingCallbackTokens.get(openKfId)!;
      this.pendingCallbackTokens.delete(openKfId);
      await this.sync(openKfId, callbackToken);
    }
  }

  private async sync(openKfId: string, callbackToken: string): Promise<void> {
    if (!this.config.openKfIds.has(openKfId)) {
      console.warn(JSON.stringify({ level: 'warn', event: 'wecom_kf_ignored_account', openKfId }));
      return;
    }
    let cursor = this.store.getKfCursor(openKfId);
    do {
      const page = await this.kf.syncMessages(openKfId, callbackToken, cursor);
      for (const message of page.messages) await this.handleMessage(message);
      if (page.nextCursor) {
        cursor = page.nextCursor;
        this.store.setKfCursor(openKfId, cursor);
      }
      if (page.hasMore && !page.nextCursor) throw new Error('微信客服 sync_msg 返回 has_more 但未返回 next_cursor');
      if (!page.hasMore) return;
    } while (true);
  }

  private async handleMessage(message: KfMessage): Promise<void> {
    // sync_msg 也会返回系统事件和接待人员在企业微信中发送的消息；仅客户消息可以触发打印。
    if (message.origin !== 3) return;
    if (!message.external_userid || !message.msgid || !message.open_kfid) return;
    const incoming = this.toIncoming(message);
    if (!incoming) {
      await this.safeReply(message, '暂不支持该消息类型；请发送文字、图片或受支持的文件。');
      return;
    }
    if (!this.config.allowedExternalUsers.has(message.external_userid)) {
      // external_userid 是客服通道唯一可用的用户标识，首次绑定时供管理员复制到白名单。
      console.warn(JSON.stringify({ level: 'warn', event: 'wecom_kf_ignored_sender', externalUserId: message.external_userid }));
    }
    try {
      const result = await this.printGateway.process(incoming);
      await this.safeReply(message, result.reply);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'wecom_kf_processing_failed', msgId: message.msgid, error: errorDetail(error) }));
      await this.safeReply(message, '处理失败，请稍后重试。');
    }
  }

  private toIncoming(message: KfMessage): IncomingMessage | undefined {
    const base = { msgId: message.msgid, userId: message.external_userid! };
    if (message.msgtype === 'text' && message.text?.content !== undefined) {
      return { ...base, loadFiles: async (): Promise<PrintableFile[]> => [{ filename: 'message.txt', contentType: 'text/plain', buffer: Buffer.from(message.text!.content!, 'utf8') }] };
    }
    if (message.msgtype === 'image' && message.image?.media_id) {
      return { ...base, loadFiles: async () => [await this.kf.downloadMedia(message.image!.media_id!, 'image')] };
    }
    if (message.msgtype === 'file' && message.file?.media_id) {
      return { ...base, loadFiles: async () => [await this.kf.downloadMedia(message.file!.media_id!, 'file')] };
    }
    return undefined;
  }

  private async safeReply(message: KfMessage, content: string): Promise<void> {
    try {
      await this.kf.sendText(message.open_kfid, message.external_userid!, content);
    } catch (error) {
      // 客服通道对每位用户有 48 小时窗口和 5 条限制；失败不能中断打印或导致进程退出。
      console.error(JSON.stringify({ level: 'warn', event: 'wecom_kf_reply_failed', msgId: message.msgid, error: errorDetail(error) }));
    }
  }
}
