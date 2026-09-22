package main

import "time"

type JobStatus string

const (
	StatusReceived    JobStatus = "received"
	StatusDownloading JobStatus = "downloading"
	StatusValidating  JobStatus = "validating"
	StatusSubmitting  JobStatus = "submitting"
	StatusAccepted    JobStatus = "accepted"
	StatusRejected    JobStatus = "rejected"
	StatusUncertain   JobStatus = "uncertain"
)

type PrintableFile struct {
	Filename, ContentType string
	Buffer                []byte
}
type PrintReceipt struct {
	JobID    string
	Pages    *int
	Filename string
}
type CupsWebPrintRecord struct {
	Filename, JobID   string
	Pages             int
	Status, CreatedAt string
}
type StoredMessage struct {
	MsgID, UserID        string
	Status               JobStatus
	Result               string
	CreatedAt, UpdatedAt int64
}
type PendingPrint struct {
	MsgID, UserID, OpenKfID, Kind, Payload, Status string
	ExpiresAt, CreatedAt                           int64
}
type TrackedPrintJob struct {
	MessageID, UserID, OpenKfID, JobID, Status string
	CreatedAt                                  int64
}
type KfMessage struct {
	MsgID          string `json:"msgid"`
	ExternalUserID string `json:"external_userid"`
	OpenKfID       string `json:"open_kfid"`
	MsgType        string `json:"msgtype"`
	SendTime       int64  `json:"send_time"`
	Origin         int    `json:"origin"`
	Text           *struct {
		Content string `json:"content"`
		MenuID  string `json:"menu_id"`
	} `json:"text,omitempty"`
	Image *struct {
		MediaID string `json:"media_id"`
	} `json:"image,omitempty"`
	File *struct {
		MediaID string `json:"media_id"`
	} `json:"file,omitempty"`
}

type IncomingMessage struct {
	MsgID, UserID string
	LoadFiles     func() ([]PrintableFile, error)
}
type ProcessingResult struct {
	Status   JobStatus
	Reply    string
	Receipts []PrintReceipt
}
type taskNotification struct {
	OpenKfID, UserID, Kind string
	MessageIDs, JobIDs     []string
}

var nowMillis = func() int64 { return time.Now().UnixMilli() }
