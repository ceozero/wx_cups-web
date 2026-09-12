import type { Config } from './config.js';
import { CupsJobStatusClient, type CupsJobState } from './cups-job-status.js';
import { PrintGateway } from './gateway.js';
import { MessageStore } from './store.js';
import type { IncomingMessage, PendingPrint, PrintableFile } from './types.js';
import { WecomKfClient, type KfMessage } from './wecom-kf-client.js';

const MENU_PREFIX = 'print';

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

function menuId(action: 'confirm' | 'cancel', msgId: string): string | undefined {
  // 微信客服菜单 ID 上限为 64 字节，且只接受本服务生成的消息标识。
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(msgId)) return undefined;
  return `${MENU_PREFIX}:${action}:${msgId}`;
}

function parseMenuId(value: string | undefined): { action: 'confirm' | 'cancel'; msgId: string } | undefined {
  const match = /^print:(confirm|cancel):([A-Za-z0-9_-]{1,48})$/.exec(value ?? '');
  return match ? { action: match[1] as 'confirm' | 'cancel', msgId: match[2] } : undefined;
}

/** 企业微信客服回调只负责唤醒；具体消息由 sync_msg 拉取。 */
export class WecomKfGateway {
  private readonly syncInFlight = new Map<string, Promise<void>>();
  private readonly pendingCallbackTokens = new Map<string, string>();
  private readonly statusClient: Pick<CupsJobStatusClient, 'getStatus'>;
  private statusPolling = false;
  private statusTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly store: MessageStore,
    private readonly printGateway: PrintGateway,
    private readonly kf: WecomKfClient,
    statusClient: Pick<CupsJobStatusClient, 'getStatus'> = new CupsJobStatusClient(config),
  ) {
    this.statusClient = statusClient;
  }

  startBackgroundWorkers(): void {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => { void this.pollPrintJobs(); }, this.config.printStatusPollMs);
    void this.pollPrintJobs();
  }

  stopBackgroundWorkers(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
  }

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

  /** 已确认的 CUPS 任务在这里获得最终状态；只通知一次，重启后会继续查询。 */
  async pollPrintJobs(): Promise<void> {
    if (this.statusPolling) return;
    this.statusPolling = true;
    try {
      for (const job of this.store.listSubmittedPrintJobs()) {
        if (Date.now() - job.createdAt >= this.config.printStatusTimeoutMs) {
          if (this.store.finishTrackedPrintJob(job.messageId, 'timeout')) {
            await this.safeSendText(job.openKfId, job.userId, `CUPS 任务 #${job.jobId} 在限定时间内未确认完成，请查看打印机或 cups-web 管理后台。`, job.messageId);
          }
          continue;
        }
        let state: CupsJobState;
        try {
          state = await this.statusClient.getStatus(job.jobId);
        } catch (error) {
          console.warn(JSON.stringify({ level: 'warn', event: 'cups_job_status_check_failed', messageId: job.messageId, error: errorDetail(error) }));
          continue;
        }
        if (state === 'completed' && this.store.finishTrackedPrintJob(job.messageId, 'completed')) {
          await this.safeSendText(job.openKfId, job.userId, `CUPS 已完成任务 #${job.jobId}。请以实际出纸为准。`, job.messageId);
        }
        if (state === 'failed' && this.store.finishTrackedPrintJob(job.messageId, 'failed')) {
          await this.safeSendText(job.openKfId, job.userId, `CUPS 任务 #${job.jobId} 已取消或失败，请检查打印机或 cups-web 管理后台。`, job.messageId);
        }
      }
    } finally {
      this.statusPolling = false;
    }
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
    if (message.origin !== 3 || !message.external_userid || !message.msgid || !message.open_kfid) return;
    const selection = parseMenuId(message.text?.menu_id);
    if (selection) return this.handleMenuSelection(message, selection);
    await this.requestConfirmation(message);
  }

  private async requestConfirmation(message: KfMessage): Promise<void> {
    const pending = this.toPendingPrint(message);
    if (!pending) {
      await this.safeReply(message, '暂不支持该消息类型；请发送文字、图片或受支持的文件。');
      return;
    }
    if (!this.config.allowedExternalUsers.has(message.external_userid!)) {
      console.warn(JSON.stringify({ level: 'warn', event: 'wecom_kf_ignored_sender', externalUserId: message.external_userid }));
      await this.safeReply(message, '无打印权限，请联系管理员开通白名单。');
      return;
    }
    const confirmId = menuId('confirm', message.msgid);
    const cancelId = menuId('cancel', message.msgid);
    if (!confirmId || !cancelId) {
      await this.safeReply(message, '该消息无法生成确认操作，请重新发送。');
      return;
    }
    const created = this.store.createPendingPrint({ ...pending, expiresAt: Date.now() + this.config.printConfirmationTtlMs });
    if (!created) return; // 微信客服重复投递时不重复发送菜单。
    try {
      await this.kf.sendPrintConfirmationMenu(message.open_kfid, message.external_userid!, confirmId, cancelId, message.msgid);
    } catch (error) {
      console.error(JSON.stringify({ level: 'warn', event: 'wecom_kf_confirmation_menu_failed', msgId: message.msgid, error: errorDetail(error) }));
    }
  }

  private async handleMenuSelection(message: KfMessage, selection: { action: 'confirm' | 'cancel'; msgId: string }): Promise<void> {
    const userId = message.external_userid!;
    const openKfId = message.open_kfid;
    if (selection.action === 'cancel') {
      const cancelled = this.store.cancelPendingPrint(selection.msgId, userId, openKfId);
      await this.safeReply(message, cancelled ? '已取消，本次内容不会打印。' : '该确认已失效或已处理。');
      return;
    }
    const pending = this.store.confirmPendingPrint(selection.msgId, userId, openKfId);
    if (!pending || pending.status === 'cancelled' || pending.expiresAt < Date.now()) {
      await this.safeReply(message, '该确认已失效，请重新发送需要打印的内容。');
      return;
    }
    try {
      const result = await this.printGateway.process(this.toIncoming(pending));
      await this.safeReply(message, result.reply);
      if (result.status === 'accepted' && result.receipts?.length === 1) {
        this.store.trackPrintJob({ messageId: pending.msgId, userId: pending.userId, openKfId: pending.openKfId, jobId: String(result.receipts[0].jobId) });
        await this.pollPrintJobs();
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'wecom_kf_processing_failed', msgId: pending.msgId, error: errorDetail(error) }));
      await this.safeReply(message, '处理失败，请稍后重试。');
    }
  }

  private toPendingPrint(message: KfMessage): Omit<PendingPrint, 'status' | 'expiresAt' | 'createdAt'> | undefined {
    const base = { msgId: message.msgid, userId: message.external_userid!, openKfId: message.open_kfid };
    if (message.msgtype === 'text' && message.text?.content !== undefined) return { ...base, kind: 'text', payload: message.text.content };
    if (message.msgtype === 'image' && message.image?.media_id) return { ...base, kind: 'image', payload: message.image.media_id };
    if (message.msgtype === 'file' && message.file?.media_id) return { ...base, kind: 'file', payload: message.file.media_id };
    return undefined;
  }

  private toIncoming(pending: PendingPrint): IncomingMessage {
    const base = { msgId: pending.msgId, userId: pending.userId };
    if (pending.kind === 'text') {
      return { ...base, loadFiles: async (): Promise<PrintableFile[]> => [{ filename: 'message.txt', contentType: 'text/plain', buffer: Buffer.from(pending.payload, 'utf8') }] };
    }
    const mediaType: 'image' | 'file' = pending.kind === 'image' ? 'image' : 'file';
    return { ...base, loadFiles: async (): Promise<PrintableFile[]> => [await this.kf.downloadMedia(pending.payload, mediaType)] };
  }

  private async safeReply(message: KfMessage, content: string): Promise<void> {
    await this.safeSendText(message.open_kfid, message.external_userid!, content, message.msgid);
  }

  private async safeSendText(openKfId: string, externalUserId: string, content: string, msgId: string): Promise<void> {
    try {
      await this.kf.sendText(openKfId, externalUserId, content, msgId);
    } catch (error) {
      // 客服通道对每位用户有 48 小时窗口和 5 条限制；失败不能中断打印或导致进程退出。
      console.error(JSON.stringify({ level: 'warn', event: 'wecom_kf_reply_failed', msgId, error: errorDetail(error) }));
    }
  }
}
