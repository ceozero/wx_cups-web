import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JobStatus, StoredMessage } from './types.js';

interface Row {
  msg_id: string;
  user_id: string;
  status: JobStatus;
  result: string | null;
  created_at: number;
  updated_at: number;
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
}
