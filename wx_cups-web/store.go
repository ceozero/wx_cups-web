package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

type MessageStore struct{ db *sql.DB }

func newStore(dataDir string) (*MessageStore, error) {
	path := ":memory:"
	if dataDir != ":memory:" {
		if err := os.MkdirAll(dataDir, 0755); err != nil {
			return nil, err
		}
		path = filepath.Join(dataDir, "gateway.sqlite")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	s := &MessageStore{db}
	schema := []string{`PRAGMA journal_mode=WAL`, `CREATE TABLE IF NOT EXISTS messages (msg_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`, `CREATE INDEX IF NOT EXISTS messages_user_created_idx ON messages(user_id,created_at)`, `CREATE TABLE IF NOT EXISTS kf_cursors(open_kfid TEXT PRIMARY KEY,cursor TEXT NOT NULL,updated_at INTEGER NOT NULL)`, `CREATE TABLE IF NOT EXISTS pending_prints(msg_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,open_kfid TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)`, `CREATE INDEX IF NOT EXISTS pending_prints_user_idx ON pending_prints(user_id,created_at)`, `CREATE TABLE IF NOT EXISTS tracked_print_jobs(message_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,open_kfid TEXT NOT NULL,job_id TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`, `CREATE INDEX IF NOT EXISTS tracked_print_jobs_status_idx ON tracked_print_jobs(status,created_at)`, `CREATE TABLE IF NOT EXISTS print_history(message_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,filename TEXT NOT NULL,job_id TEXT NOT NULL,pages INTEGER,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`, `CREATE INDEX IF NOT EXISTS print_history_user_created_idx ON print_history(user_id,created_at DESC)`}
	for _, q := range schema {
		if _, err = db.Exec(q); err != nil {
			db.Close()
			return nil, err
		}
	}
	_, err = db.Exec(`UPDATE messages SET status='uncertain',result='网关在处理过程中重启，提交状态未知；请查看打印机或 cups-web 管理后台。',updated_at=? WHERE status IN ('received','downloading','validating','submitting')`, nowMillis())
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}
func (s *MessageStore) Close() error { return s.db.Close() }
func (s *MessageStore) reserve(msg, user string) (bool, StoredMessage, error) {
	now := nowMillis()
	r, err := s.db.Exec(`INSERT INTO messages(msg_id,user_id,status,created_at,updated_at) VALUES(?,?, 'received',?,?) ON CONFLICT(msg_id) DO NOTHING`, msg, user, now, now)
	if err != nil {
		return false, StoredMessage{}, err
	}
	m, err := s.get(msg)
	return affected(r) == 1, m, err
}
func affected(r sql.Result) int64 { n, _ := r.RowsAffected(); return n }
func (s *MessageStore) get(id string) (StoredMessage, error) {
	var m StoredMessage
	var result sql.NullString
	err := s.db.QueryRow(`SELECT msg_id,user_id,status,result,created_at,updated_at FROM messages WHERE msg_id=?`, id).Scan(&m.MsgID, &m.UserID, &m.Status, &result, &m.CreatedAt, &m.UpdatedAt)
	m.Result = result.String
	return m, err
}
func (s *MessageStore) transition(id string, status JobStatus, result string) error {
	r, err := s.db.Exec(`UPDATE messages SET status=?,result=?,updated_at=? WHERE msg_id=?`, status, nullString(result), nowMillis(), id)
	if err != nil {
		return err
	}
	if affected(r) != 1 {
		return fmt.Errorf("消息记录不存在：%s", id)
	}
	return nil
}
func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (s *MessageStore) countRecentForUser(user string, since int64) (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE user_id=? AND created_at>=?`, user, since).Scan(&n)
	return n, err
}
func (s *MessageStore) getKfCursor(id string) (string, error) {
	var x string
	err := s.db.QueryRow(`SELECT cursor FROM kf_cursors WHERE open_kfid=?`, id).Scan(&x)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return x, err
}
func (s *MessageStore) setKfCursor(id, cursor string) error {
	_, err := s.db.Exec(`INSERT INTO kf_cursors(open_kfid,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(open_kfid) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at`, id, cursor, nowMillis())
	return err
}
func (s *MessageStore) createPending(p PendingPrint) (bool, error) {
	r, err := s.db.Exec(`INSERT INTO pending_prints(msg_id,user_id,open_kfid,kind,payload,status,expires_at,created_at) VALUES(?,?,?,?,?,'pending',?,?) ON CONFLICT(msg_id) DO NOTHING`, p.MsgID, p.UserID, p.OpenKfID, p.Kind, p.Payload, p.ExpiresAt, nowMillis())
	return affected(r) == 1, err
}
func scanPending(rows *sql.Rows) ([]PendingPrint, error) {
	defer rows.Close()
	out := []PendingPrint{}
	for rows.Next() {
		var p PendingPrint
		if err := rows.Scan(&p.MsgID, &p.UserID, &p.OpenKfID, &p.Kind, &p.Payload, &p.Status, &p.ExpiresAt, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (s *MessageStore) listActivePending(user, open string, now int64) ([]PendingPrint, error) {
	r, err := s.db.Query(`SELECT msg_id,user_id,open_kfid,kind,payload,status,expires_at,created_at FROM pending_prints WHERE user_id=? AND open_kfid=? AND status='pending' AND expires_at>=? ORDER BY created_at,msg_id`, user, open, now)
	if err != nil {
		return nil, err
	}
	return scanPending(r)
}
func (s *MessageStore) pendingBatch(id, user, open, action string) ([]PendingPrint, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, false, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	now := nowMillis()
	rows, err := tx.Query(`SELECT msg_id,user_id,open_kfid,kind,payload,status,expires_at,created_at FROM pending_prints WHERE user_id=? AND open_kfid=? AND status='pending' AND expires_at>=? ORDER BY created_at,msg_id`, user, open, now)
	if err != nil {
		return nil, false, err
	}
	pending, err := scanPending(rows)
	if err != nil {
		return nil, false, err
	}
	if len(pending) == 0 || pending[len(pending)-1].MsgID != id {
		if err = tx.Commit(); err != nil {
			return nil, false, err
		}
		return nil, false, nil
	}
	_, err = tx.Exec(`UPDATE pending_prints SET status=? WHERE user_id=? AND open_kfid=? AND status='pending' AND expires_at>=?`, action, user, open, now)
	if err != nil {
		return nil, false, err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return pending, true, nil
}
func (s *MessageStore) confirmPending(id, user, open string) ([]PendingPrint, bool, error) {
	return s.pendingBatch(id, user, open, "confirmed")
}
func (s *MessageStore) cancelPending(id, user, open string) (bool, error) {
	_, ok, err := s.pendingBatch(id, user, open, "cancelled")
	return ok, err
}
func (s *MessageStore) trackPrintJob(job TrackedPrintJob) error {
	_, err := s.db.Exec(`INSERT INTO tracked_print_jobs(message_id,user_id,open_kfid,job_id,status,created_at,updated_at) VALUES(?,?,?,?, 'submitted',?,?) ON CONFLICT(message_id) DO NOTHING`, job.MessageID, job.UserID, job.OpenKfID, job.JobID, nowMillis(), nowMillis())
	return err
}
func (s *MessageStore) listSubmittedJobs() ([]TrackedPrintJob, error) {
	r, err := s.db.Query(`SELECT message_id,user_id,open_kfid,job_id,status,created_at FROM tracked_print_jobs WHERE status='submitted' ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	out := []TrackedPrintJob{}
	for r.Next() {
		var j TrackedPrintJob
		if err := r.Scan(&j.MessageID, &j.UserID, &j.OpenKfID, &j.JobID, &j.Status, &j.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, r.Err()
}
func (s *MessageStore) finishJob(id, status string) (bool, error) {
	r, err := s.db.Exec(`UPDATE tracked_print_jobs SET status=?,updated_at=? WHERE message_id=? AND status='submitted'`, status, nowMillis(), id)
	return affected(r) == 1, err
}
func (s *MessageStore) addPrintHistory(job TrackedPrintJob, filename string, pages *int) error {
	_, err := s.db.Exec(`INSERT INTO print_history(message_id,user_id,filename,job_id,pages,status,created_at,updated_at) VALUES(?,?,?,?,?,'submitted',?,?) ON CONFLICT(message_id) DO NOTHING`, job.MessageID, job.UserID, filename, job.JobID, pages, nowMillis(), nowMillis())
	return err
}
func (s *MessageStore) finishHistory(id, status string) error {
	_, err := s.db.Exec(`UPDATE print_history SET status=?,updated_at=? WHERE message_id=? AND status='submitted'`, status, nowMillis(), id)
	return err
}
