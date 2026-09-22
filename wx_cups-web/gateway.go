package main

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

type PrintGateway struct {
	config Config
	store  *MessageStore
	cups   *CupsWebClient
}

func newPrintGateway(c Config, s *MessageStore, p *CupsWebClient) *PrintGateway {
	return &PrintGateway{c, s, p}
}
func (g *PrintGateway) process(m IncomingMessage) (ProcessingResult, error) {
	created, previous, err := g.store.reserve(m.MsgID, m.UserID)
	if err != nil {
		return ProcessingResult{}, err
	}
	if !created {
		reply := previous.Result
		if reply == "" {
			reply = "已接收，处理中"
		}
		return ProcessingResult{previous.Status, "该消息已处理：" + reply, nil}, nil
	}
	reject := func(reply string) (ProcessingResult, error) {
		return ProcessingResult{StatusRejected, reply, nil}, g.store.transition(m.MsgID, StatusRejected, reply)
	}
	if !g.config.AllowedExternalUsers[m.UserID] {
		return reject("无打印权限，请联系管理员开通白名单")
	}
	n, err := g.store.countRecentForUser(m.UserID, nowMillis()-int64(g.config.RateLimitWindowMS))
	if err != nil {
		return ProcessingResult{}, err
	}
	if n > g.config.RateLimitCount {
		return reject("请求过于频繁，请稍后再试")
	}
	if err := g.store.transition(m.MsgID, StatusDownloading, ""); err != nil {
		return ProcessingResult{}, err
	}
	files, err := m.LoadFiles()
	if err != nil {
		return rejectForGateway(g, m.MsgID, err)
	}
	if len(files) == 0 {
		return reject("未找到可打印内容")
	}
	if err = g.store.transition(m.MsgID, StatusValidating, ""); err != nil {
		return ProcessingResult{}, err
	}
	for i := range files {
		files[i], err = validateFile(files[i], g.config.MaxFileBytes, g.config.MaxPages)
		if err != nil {
			return rejectForGateway(g, m.MsgID, err)
		}
	}
	if err = g.store.transition(m.MsgID, StatusSubmitting, ""); err != nil {
		return ProcessingResult{}, err
	}
	receipts := []PrintReceipt{}
	for _, f := range files {
		r, e := g.cups.submit(f, m.UserID)
		if e != nil {
			return rejectForGateway(g, m.MsgID, e)
		}
		r.Filename = f.Filename
		receipts = append(receipts, r)
	}
	items := make([]string, len(receipts))
	for i, r := range receipts {
		pages := ""
		if r.Pages != nil {
			pages = fmt.Sprintf("（%d 页）", *r.Pages)
		}
		items[i] = displayJobID(r.JobID) + pages
	}
	reply := "已提交 CUPS 打印任务 " + strings.Join(items, "、") + "。该状态仅表示任务已被接收，不代表已经出纸。"
	err = g.store.transition(m.MsgID, StatusAccepted, reply)
	return ProcessingResult{StatusAccepted, reply, receipts}, err
}
func rejectForGateway(g *PrintGateway, id string, err error) (ProcessingResult, error) {
	var uncertain *SubmitUncertainError
	if errors.As(err, &uncertain) {
		reply := "提交状态未知，请查看打印机或 cups-web 管理后台；系统不会自动重发，以免重复出纸。"
		return ProcessingResult{StatusUncertain, reply, nil}, g.store.transition(id, StatusUncertain, reply)
	}
	detail := "内部处理失败"
	var v *ValidationError
	if errors.As(err, &v) {
		detail = v.Error()
	}
	var f *SubmitFailedError
	if errors.As(err, &f) {
		detail = f.Error()
	}
	reply := "未提交打印：" + detail
	return ProcessingResult{StatusRejected, reply, nil}, g.store.transition(id, StatusRejected, reply)
}

type WecomKfGateway struct {
	config        Config
	store         *MessageStore
	print         *PrintGateway
	kf            *WecomKfClient
	status        *CupsJobStatusClient
	history       *CupsWebClient
	mu            sync.Mutex
	syncing       map[string]bool
	pendingTokens map[string]string
	polling       bool
	stop          chan struct{}
}

func newWecomKfGateway(c Config, s *MessageStore, p *PrintGateway, k *WecomKfClient, status *CupsJobStatusClient, history *CupsWebClient) *WecomKfGateway {
	return &WecomKfGateway{c, s, p, k, status, history, sync.Mutex{}, map[string]bool{}, map[string]string{}, false, make(chan struct{})}
}
func (w *WecomKfGateway) startWorkers() {
	go func() {
		ticker := time.NewTicker(time.Duration(w.config.PrintStatusPollMS) * time.Millisecond)
		defer ticker.Stop()
		w.pollPrintJobs()
		for {
			select {
			case <-ticker.C:
				w.pollPrintJobs()
			case <-w.stop:
				return
			}
		}
	}()
}
func (w *WecomKfGateway) stopWorkers() {
	select {
	case <-w.stop:
	default:
		close(w.stop)
	}
}
func (w *WecomKfGateway) syncFromCallback(open, token string) {
	w.mu.Lock()
	w.pendingTokens[open] = token
	if w.syncing[open] {
		w.mu.Unlock()
		return
	}
	w.syncing[open] = true
	w.mu.Unlock()
	go func() {
		defer func() { w.mu.Lock(); delete(w.syncing, open); w.mu.Unlock() }()
		for {
			w.mu.Lock()
			token, ok := w.pendingTokens[open]
			delete(w.pendingTokens, open)
			w.mu.Unlock()
			if !ok {
				return
			}
			if err := w.sync(open, token); err != nil {
				logJSON("error", "wecom_kf_sync_failed", map[string]any{"openKfId": open, "error": err.Error()})
			}
		}
	}()
}
func (w *WecomKfGateway) sync(open, token string) error {
	if !w.config.OpenKfIDs[open] {
		logJSON("warn", "wecom_kf_ignored_account", map[string]any{"openKfId": open})
		return nil
	}
	cursor, err := w.store.getKfCursor(open)
	if err != nil {
		return err
	}
	for {
		messages, next, more, err := w.kf.syncMessages(open, token, cursor)
		if err != nil {
			return err
		}
		for _, m := range messages {
			if err := w.handleMessage(m); err != nil {
				return err
			}
		}
		if next != "" {
			cursor = next
			if err := w.store.setKfCursor(open, cursor); err != nil {
				return err
			}
		}
		if more && next == "" {
			return errors.New("微信客服 sync_msg 返回 has_more 但未返回 next_cursor")
		}
		if !more {
			return nil
		}
	}
}
func parseMenuID(value string) (string, string, bool) {
	m := regexp.MustCompile(`^print:(confirm|cancel):([A-Za-z0-9_-]{1,48})$`).FindStringSubmatch(value)
	if len(m) != 3 {
		return "", "", false
	}
	return m[1], m[2], true
}
func menuID(action, msg string) string {
	if regexp.MustCompile(`^[A-Za-z0-9_-]{1,48}$`).MatchString(msg) {
		return "print:" + action + ":" + msg
	}
	return ""
}
func (w *WecomKfGateway) handleMessage(m KfMessage) error {
	if m.Origin != 3 || m.ExternalUserID == "" || m.MsgID == "" || m.OpenKfID == "" {
		return nil
	}
	if m.Text != nil && (m.Text.MenuID == "print:records" || strings.TrimSpace(m.Text.Content) == "打印记录") {
		return w.replyHistory(m)
	}
	if m.Text != nil {
		if action, id, ok := parseMenuID(m.Text.MenuID); ok {
			return w.handleMenu(m, action, id)
		}
	}
	return w.requestConfirmation(m)
}
func (w *WecomKfGateway) toPending(m KfMessage) (PendingPrint, bool) {
	p := PendingPrint{MsgID: m.MsgID, UserID: m.ExternalUserID, OpenKfID: m.OpenKfID}
	if m.MsgType == "text" && m.Text != nil {
		p.Kind = "text"
		p.Payload = m.Text.Content
		return p, true
	}
	if m.MsgType == "image" && m.Image != nil && m.Image.MediaID != "" {
		p.Kind = "image"
		p.Payload = m.Image.MediaID
		return p, true
	}
	if m.MsgType == "file" && m.File != nil && m.File.MediaID != "" {
		p.Kind = "file"
		p.Payload = m.File.MediaID
		return p, true
	}
	return p, false
}
func pendingDisplayName(p PendingPrint, images, files int) string {
	if p.Kind == "text" {
		return textFilename(p.Payload)
	}
	if p.Kind == "image" {
		return fmt.Sprintf("图片_%02d", images)
	}
	return fmt.Sprintf("文件_%02d", files)
}
func confirmationContent(p []PendingPrint) string {
	images, files := 0, 0
	lines := make([]string, len(p))
	for i, x := range p {
		if x.Kind == "image" {
			images++
		}
		if x.Kind == "file" {
			files++
		}
		lines[i] = fmt.Sprintf("%d. %s", i+1, pendingDisplayName(x, images, files))
	}
	return "如需打印更多，继续发送打印内容\n已收到打印内容，请确认是否打印：\n\n" + strings.Join(lines, "\n")
}
func (w *WecomKfGateway) requestConfirmation(m KfMessage) error {
	p, ok := w.toPending(m)
	if !ok {
		w.safeReply(m, "暂不支持该消息类型；请发送文字、图片或受支持的文件。")
		return nil
	}
	if !w.config.AllowedExternalUsers[m.ExternalUserID] {
		logJSON("warn", "wecom_kf_ignored_sender", map[string]any{"externalUserId": m.ExternalUserID})
		w.safeReply(m, "无打印权限，请联系管理员开通白名单。")
		return nil
	}
	p.ExpiresAt = nowMillis() + int64(w.config.PrintConfirmationTTLMS)
	created, err := w.store.createPending(p)
	if err != nil {
		return err
	}
	if !created {
		return nil
	}
	batch, err := w.store.listActivePending(m.ExternalUserID, m.OpenKfID, nowMillis())
	if err != nil {
		return err
	}
	latest := batch[len(batch)-1]
	confirm, cancel := menuID("confirm", latest.MsgID), menuID("cancel", latest.MsgID)
	if confirm == "" || cancel == "" {
		w.safeReply(m, "该消息无法生成确认操作，请重新发送。")
		return nil
	}
	if err := w.kf.sendConfirmation(m.OpenKfID, m.ExternalUserID, confirmationContent(batch), confirm, cancel, len(batch), latest.MsgID); err != nil {
		logJSON("warn", "wecom_kf_confirmation_menu_failed", map[string]any{"msgId": m.MsgID, "error": err.Error()})
	}
	return nil
}
func (w *WecomKfGateway) incoming(p PendingPrint) IncomingMessage {
	m := IncomingMessage{p.MsgID, p.UserID, nil}
	if p.Kind == "text" {
		m.LoadFiles = func() ([]PrintableFile, error) {
			return []PrintableFile{{textFilename(p.Payload), "text/plain", []byte(p.Payload)}}, nil
		}
	} else {
		kind := p.Kind
		m.LoadFiles = func() ([]PrintableFile, error) {
			f, e := w.kf.downloadMedia(p.Payload, kind)
			if e != nil {
				return nil, e
			}
			return []PrintableFile{f}, nil
		}
	}
	return m
}
func (w *WecomKfGateway) handleMenu(m KfMessage, action, id string) error {
	if action == "cancel" {
		ok, err := w.store.cancelPending(id, m.ExternalUserID, m.OpenKfID)
		if err != nil {
			return err
		}
		if ok {
			w.safeReply(m, "已取消，本批次内容不会打印。")
		} else {
			w.safeReply(m, "该确认已失效，请使用最新的确认菜单。")
		}
		return nil
	}
	pending, ok, err := w.store.confirmPending(id, m.ExternalUserID, m.OpenKfID)
	if err != nil {
		return err
	}
	if !ok {
		w.safeReply(m, "该确认已失效，请使用最新的确认菜单。")
		return nil
	}
	results := []ProcessingResult{}
	for _, p := range pending {
		r, e := w.print.process(w.incoming(p))
		if e != nil {
			return e
		}
		results = append(results, r)
		if r.Status == StatusAccepted && len(r.Receipts) == 1 {
			j := TrackedPrintJob{p.MsgID, p.UserID, p.OpenKfID, r.Receipts[0].JobID, "", 0}
			_ = w.store.trackPrintJob(j)
			_ = w.store.addPrintHistory(j, r.Receipts[0].Filename, r.Receipts[0].Pages)
		}
	}
	reply := batchReply(results)
	if reply == "" {
		if len(results) == 1 {
			reply = results[0].Reply
		} else {
			lines := make([]string, len(results))
			for i, r := range results {
				lines[i] = fmt.Sprintf("%d. %s", i+1, r.Reply)
			}
			reply = fmt.Sprintf("本批次已处理 %d 个内容：\n%s", len(results), strings.Join(lines, "\n"))
		}
	}
	mustTask := false
	submitted := false
	for _, r := range results {
		mustTask = mustTask || r.Status == StatusAccepted || r.Status == StatusUncertain
		submitted = submitted || r.Status == StatusAccepted && len(r.Receipts) == 1
	}
	if mustTask {
		w.safeTaskReply(m.OpenKfID, m.ExternalUserID, reply, id)
	} else {
		w.safeReply(m, reply)
	}
	if submitted {
		go w.pollPrintJobs()
	}
	return nil
}
func batchReply(results []ProcessingResult) string {
	if len(results) < 2 {
		return ""
	}
	items := []string{}
	for _, r := range results {
		if r.Status != StatusAccepted || len(r.Receipts) != 1 {
			return ""
		}
		p := ""
		if r.Receipts[0].Pages != nil {
			p = fmt.Sprintf("（%d 页）", *r.Receipts[0].Pages)
		}
		items = append(items, displayJobID(r.Receipts[0].JobID)+p)
	}
	return "已提交 CUPS 打印任务 " + strings.Join(items, "、") + "。该状态仅表示任务已被接收，不代表已经出纸。"
}
func (w *WecomKfGateway) pollPrintJobs() {
	w.mu.Lock()
	if w.polling {
		w.mu.Unlock()
		return
	}
	w.polling = true
	w.mu.Unlock()
	defer func() { w.mu.Lock(); w.polling = false; w.mu.Unlock() }()
	jobs, err := w.store.listSubmittedJobs()
	if err != nil {
		logJSON("error", "cups_job_list_failed", map[string]any{"error": err.Error()})
		return
	}
	notes := map[string]*taskNotification{}
	for _, j := range jobs {
		kind := ""
		if nowMillis()-j.CreatedAt >= int64(w.config.PrintStatusTimeoutMS) {
			kind = "timeout"
		} else {
			state, e := w.status.getStatus(j.JobID)
			if e != nil {
				logJSON("warn", "cups_job_status_check_failed", map[string]any{"messageId": j.MessageID, "error": e.Error()})
				continue
			}
			if state == CupsCompleted {
				kind = "completed"
			}
			if state == CupsFailed {
				kind = "failed"
			}
		}
		if kind == "" {
			continue
		}
		ok, e := w.store.finishJob(j.MessageID, kind)
		if e != nil || !ok {
			continue
		}
		_ = w.store.finishHistory(j.MessageID, kind)
		key := j.OpenKfID + "\x00" + j.UserID + "\x00" + kind
		n := notes[key]
		if n == nil {
			n = &taskNotification{j.OpenKfID, j.UserID, kind, nil, nil}
			notes[key] = n
		}
		n.MessageIDs = append(n.MessageIDs, j.MessageID)
		n.JobIDs = append(n.JobIDs, displayJobID(j.JobID))
	}
	for _, n := range notes {
		content := taskContent(n.Kind, n.JobIDs)
		w.safeTaskReply(n.OpenKfID, n.UserID, content, strings.Join(n.MessageIDs, ","))
	}
}
func taskContent(kind string, jobs []string) string {
	j := strings.Join(jobs, "、")
	if kind == "completed" {
		return "CUPS 已完成打印任务 " + j + "。请以实际出纸为准。"
	}
	if kind == "failed" {
		return "CUPS 打印任务 " + j + " 已取消或失败，请检查打印机或 cups-web 管理后台。"
	}
	return "CUPS 打印任务 " + j + " 在限定时间内未确认完成，请查看打印机或 cups-web 管理后台。"
}
func (w *WecomKfGateway) replyHistory(m KfMessage) error {
	records, err := w.history.listPrintRecords(m.ExternalUserID, 5)
	if err != nil {
		logJSON("warn", "cups_web_history_failed", map[string]any{"externalUserId": m.ExternalUserID, "error": err.Error()})
		w.safeReply(m, "查询 cups-web 打印记录失败，请稍后重试。")
		return nil
	}
	if len(records) == 0 {
		w.safeReply(m, "cups-web 暂无打印记录。")
		return nil
	}
	lines := make([]string, len(records))
	for i, r := range records {
		pages, job := "", ""
		if r.Pages > 0 {
			pages = fmt.Sprintf(" · %d 页", r.Pages)
		}
		if r.JobID != "" {
			job = " · 任务 " + displayJobID(r.JobID)
		}
		status := map[string]string{"queued": "排队中", "printed": "已打印"}[r.Status]
		if status == "" {
			status = r.Status
		}
		t, err := time.Parse(time.RFC3339, r.CreatedAt)
		when := "未知时间"
		if err == nil {
			when = t.In(time.FixedZone("CST", 8*3600)).Format("01/02 15:04")
		}
		lines[i] = fmt.Sprintf("%d. %s · %s%s%s · %s", i+1, r.Filename, status, job, pages, when)
	}
	w.safeReply(m, fmt.Sprintf("cups-web 最近 %d 条打印记录：\n%s", len(records), strings.Join(lines, "\n")))
	return nil
}
func (w *WecomKfGateway) safeReply(m KfMessage, content string) {
	if err := w.kf.sendText(m.OpenKfID, m.ExternalUserID, content, m.MsgID); err != nil {
		logJSON("warn", "wecom_kf_reply_failed", map[string]any{"msgId": m.MsgID, "error": err.Error()})
	}
}
func (w *WecomKfGateway) safeTaskReply(open, user, content, id string) {
	if err := w.kf.sendRecordMenu(open, user, content, id); err != nil {
		logJSON("warn", "wecom_kf_task_menu_failed", map[string]any{"msgId": id, "error": err.Error()})
	}
}
