import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JobStatus, PendingPrint, PendingPrintKind, PrintHistoryRecord, StoredMessage, TrackedPrintJob } from './types.js';

interface Row {
  msg_id: string;
  user_id: string;
  status: JobStatus;
  result: string | null;
  created_at: number;
  updated_at: number;
}

interface PendingPrintRow {
  msg_id: string;
  user_id: string;
  open_kfid: string;
  kind: PendingPrintKind;
  payload: string;
  status: PendingPrint['status'];
  expires_at: number;
  created_at: number;
}

interface TrackedPrintJobRow {
  message_id: string;
  user_id: string;
  open_kfid: string;
  job_id: string;
  status: TrackedPrintJob['status'];
  created_at: number;
}

interface PrintHistoryRow {
  message_id: string;
  user_id: string;
  filename: string;
  job_id: string;
  pages: number | null;
  status: PrintHistoryRecord['status'];
  created_at: number;
}

export class MessageStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const databasePath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'gateway.sqlite');
    if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        msg_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_user_created_idx ON messages(user_id, created_at);
      CREATE TABLE IF NOT EXISTS kf_cursors (
        open_kfid TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_prints (
        msg_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        open_kfid TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_prints_user_idx ON pending_prints(user_id, created_at);
      CREATE TABLE IF NOT EXISTS tracked_print_jobs (
        message_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        open_kfid TEXT NOT NULL,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tracked_print_jobs_status_idx ON tracked_print_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS print_history (
        message_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        job_id TEXT NOT NULL,
        pages INTEGER,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS print_history_user_created_idx ON print_history(user_id, created_at DESC);
    `);
    this.recoverInterruptedMessages();
  }

  reserve(msgId: string, userId: string, now = Date.now()): { created: boolean; message: StoredMessage } {
    const result = this.db.prepare(`
      INSERT INTO messages(msg_id, user_id, status, created_at, updated_at)
      VALUES (?, ?, 'received', ?, ?)
      ON CONFLICT(msg_id) DO NOTHING
    `).run(msgId, userId, now, now);
    return { created: result.changes === 1, message: this.get(msgId)! };
  }

  get(msgId: string): StoredMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE msg_id = ?').get(msgId) as Row | undefined;
    return row && this.toMessage(row);
  }

  transition(msgId: string, status: JobStatus, result?: string, now = Date.now()): void {
    const update = this.db.prepare('UPDATE messages SET status = ?, result = ?, updated_at = ? WHERE msg_id = ?')
      .run(status, result ?? null, now, msgId);
    if (update.changes !== 1) throw new Error(`消息记录不存在：${msgId}`);
  }

  countRecentForUser(userId: string, since: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE user_id = ? AND created_at >= ?').get(userId, since) as { count: number };
    return row.count;
  }

  getKfCursor(openKfId: string): string | undefined {
    const row = this.db.prepare('SELECT cursor FROM kf_cursors WHERE open_kfid = ?').get(openKfId) as { cursor: string } | undefined;
    return row?.cursor;
  }

  setKfCursor(openKfId: string, cursor: string, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO kf_cursors(open_kfid, cursor, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(open_kfid) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
    `).run(openKfId, cursor, now);
  }

  createPendingPrint(pending: Omit<PendingPrint, 'status' | 'createdAt'>, now = Date.now()): boolean {
    const result = this.db.prepare(`
      INSERT INTO pending_prints(msg_id, user_id, open_kfid, kind, payload, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(msg_id) DO NOTHING
    `).run(pending.msgId, pending.userId, pending.openKfId, pending.kind, pending.payload, pending.expiresAt, now);
    return result.changes === 1;
  }

  /** 原子地取得确认权，避免菜单重复回调造成二次打印。 */
  confirmPendingPrint(msgId: string, userId: string, openKfId: string, now = Date.now()): PendingPrint | undefined {
    this.db.prepare(`
      UPDATE pending_prints SET status = 'confirmed'
      WHERE msg_id = ? AND user_id = ? AND open_kfid = ? AND status = 'pending' AND expires_at >= ?
    `).run(msgId, userId, openKfId, now);
    return this.getPendingPrint(msgId, userId, openKfId);
  }

  cancelPendingPrint(msgId: string, userId: string, openKfId: string, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE pending_prints SET status = 'cancelled'
      WHERE msg_id = ? AND user_id = ? AND open_kfid = ? AND status = 'pending' AND expires_at >= ?
    `).run(msgId, userId, openKfId, now);
    return result.changes === 1;
  }

  getPendingPrint(msgId: string, userId: string, openKfId: string): PendingPrint | undefined {
    const row = this.db.prepare('SELECT * FROM pending_prints WHERE msg_id = ? AND user_id = ? AND open_kfid = ?')
      .get(msgId, userId, openKfId) as PendingPrintRow | undefined;
    return row && this.toPendingPrint(row);
  }

  trackPrintJob(job: Omit<TrackedPrintJob, 'status' | 'createdAt'>, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO tracked_print_jobs(message_id, user_id, open_kfid, job_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'submitted', ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(job.messageId, job.userId, job.openKfId, job.jobId, now, now);
  }

  listSubmittedPrintJobs(): TrackedPrintJob[] {
    const rows = this.db.prepare("SELECT * FROM tracked_print_jobs WHERE status = 'submitted' ORDER BY created_at ASC")
      .all() as unknown as TrackedPrintJobRow[];
    return rows.map((row) => this.toTrackedPrintJob(row));
  }

  finishTrackedPrintJob(messageId: string, status: Exclude<TrackedPrintJob['status'], 'submitted'>, now = Date.now()): boolean {
    const result = this.db.prepare("UPDATE tracked_print_jobs SET status = ?, updated_at = ? WHERE message_id = ? AND status = 'submitted'")
      .run(status, now, messageId);
    return result.changes === 1;
  }

  addPrintHistory(record: Omit<PrintHistoryRecord, 'status' | 'createdAt'>, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO print_history(message_id, user_id, filename, job_id, pages, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(record.messageId, record.userId, record.filename, record.jobId, record.pages ?? null, now, now);
  }

  finishPrintHistory(messageId: string, status: Exclude<PrintHistoryRecord['status'], 'submitted'>, now = Date.now()): void {
    this.db.prepare("UPDATE print_history SET status = ?, updated_at = ? WHERE message_id = ? AND status = 'submitted'")
      .run(status, now, messageId);
  }

  listRecentPrintHistory(userId: string, limit = 5): PrintHistoryRecord[] {
    const rows = this.db.prepare(`
      SELECT message_id, user_id, filename, job_id, pages, status, created_at
      FROM print_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit) as unknown as PrintHistoryRow[];
    return rows.map((row) => ({
      messageId: row.message_id, userId: row.user_id, filename: row.filename, jobId: row.job_id,
      pages: row.pages ?? undefined, status: row.status, createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }

  /**
   * 进程在上传期间被重启时，无法确认上游是否已经创建 CUPS 作业。
   * 将非终态转为 uncertain，宁可人工核对也绝不因重启自动补发。
   */
  private recoverInterruptedMessages(): void {
    this.db.prepare(`
      UPDATE messages
      SET status = 'uncertain', result = '网关在处理过程中重启，提交状态未知；请查看打印机或 cups-web 管理后台。', updated_at = ?
      WHERE status IN ('received', 'downloading', 'validating', 'submitting')
    `).run(Date.now());
  }

  private toMessage(row: Row): StoredMessage {
    return { msgId: row.msg_id, userId: row.user_id, status: row.status, result: row.result ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private toPendingPrint(row: PendingPrintRow): PendingPrint {
    return {
      msgId: row.msg_id, userId: row.user_id, openKfId: row.open_kfid, kind: row.kind, payload: row.payload,
      status: row.status, expiresAt: row.expires_at, createdAt: row.created_at,
    };
  }

  private toTrackedPrintJob(row: TrackedPrintJobRow): TrackedPrintJob {
    return {
      messageId: row.message_id, userId: row.user_id, openKfId: row.open_kfid, jobId: row.job_id,
      status: row.status, createdAt: row.created_at,
    };
  }
}
