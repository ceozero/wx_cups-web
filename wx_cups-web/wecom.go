package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var wecomAPIBase = "https://qyapi.weixin.qq.com/cgi-bin"

type wecomAPIError struct {
	message   string
	retryable bool
}

func (e *wecomAPIError) Error() string { return e.message }
func stableWecomMessageID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:32]
}
func retryableStatus(code int) bool { return code == 408 || code == 429 || code >= 500 }
func retryableErrCode(code int) bool {
	switch code {
	case -1, 40001, 40014, 42001, 45009:
		return true
	}
	return false
}

type WecomKfClient struct {
	config      Config
	client      *http.Client
	mu          sync.Mutex
	accessToken string
	expiresAt   int64
	replyMu     sync.Mutex
	nextReplyAt map[string]time.Time
}

func newWecomKfClient(c Config) *WecomKfClient {
	return &WecomKfClient{config: c, client: &http.Client{Timeout: time.Duration(c.WecomAPIRequestTimeoutMS) * time.Millisecond}, nextReplyAt: map[string]time.Time{}}
}
func (c *WecomKfClient) withRetry(operation string, fn func() error) error {
	for attempt := 0; ; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		retry := false
		if e, ok := err.(*wecomAPIError); ok {
			retry = e.retryable
		} else if e, ok := err.(*httpError); ok {
			retry = retryableStatus(e.status)
		} else {
			retry = true
		}
		if !retry || attempt >= c.config.WecomAPIMaxRetries {
			return err
		}
		delay := time.Duration(c.config.WecomAPIRetryBaseMS*(1<<attempt)) * time.Millisecond
		logJSON("warn", "wecom_api_retry", map[string]any{"operation": operation, "attempt": attempt + 1, "delayMs": delay.Milliseconds(), "error": err.Error()})
		time.Sleep(delay)
	}
}

type httpError struct{ status int }

func (e *httpError) Error() string { return fmt.Sprintf("HTTP %d", e.status) }
func (c *WecomKfClient) token() (string, error) {
	c.mu.Lock()
	if c.accessToken != "" && c.expiresAt > nowMillis() {
		v := c.accessToken
		c.mu.Unlock()
		return v, nil
	}
	c.mu.Unlock()
	var token string
	err := c.withRetry("获取微信客服 access_token", func() error {
		u := wecomAPIBase + "/gettoken?" + url.Values{"corpid": {c.config.WecomCorpID}, "corpsecret": {c.config.WecomKfSecret}}.Encode()
		resp, err := c.client.Get(u)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return &httpError{resp.StatusCode}
		}
		var r struct {
			ErrCode     int    `json:"errcode"`
			ErrMsg      string `json:"errmsg"`
			AccessToken string `json:"access_token"`
			ExpiresIn   int    `json:"expires_in"`
		}
		if err = json.NewDecoder(resp.Body).Decode(&r); err != nil {
			return err
		}
		if r.ErrCode != 0 || r.AccessToken == "" || r.ExpiresIn == 0 {
			return &wecomAPIError{fmt.Sprintf("获取微信客服 access_token失败（errcode=%d，errmsg=%s）", r.ErrCode, r.ErrMsg), retryableErrCode(r.ErrCode)}
		}
		token = r.AccessToken
		c.mu.Lock()
		c.accessToken = token
		c.expiresAt = nowMillis() + int64(max(0, r.ExpiresIn-120))*1000
		c.mu.Unlock()
		return nil
	})
	return token, err
}
func (c *WecomKfClient) post(path string, payload any, result any) error {
	return c.withRetry("企业微信接口 "+path, func() error {
		token, err := c.token()
		if err != nil {
			return err
		}
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		u := wecomAPIBase + "/" + path + "?" + url.Values{"access_token": {token}}.Encode()
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, u, bytes.NewReader(data))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return &httpError{resp.StatusCode}
		}
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		var api struct {
			ErrCode int    `json:"errcode"`
			ErrMsg  string `json:"errmsg"`
		}
		if err = json.Unmarshal(raw, &api); err != nil {
			return err
		}
		if api.ErrCode != 0 {
			// msgid 是调用方主动设置的幂等键。响应丢失后的重试会得到 95033，
			// 表示同一条客服消息此前已被企业微信接收，应按成功处理。
			if path == "kf/send_msg" && api.ErrCode == 95033 {
				logJSON("info", "wecom_kf_message_already_accepted", map[string]any{"path": path})
				return nil
			}
			if api.ErrCode == 40001 || api.ErrCode == 40014 || api.ErrCode == 42001 {
				c.mu.Lock()
				c.accessToken = ""
				c.mu.Unlock()
			}
			return &wecomAPIError{fmt.Sprintf("企业微信接口 %s失败（errcode=%d，errmsg=%s）", path, api.ErrCode, api.ErrMsg), retryableErrCode(api.ErrCode)}
		}
		return json.Unmarshal(raw, result)
	})
}
func (c *WecomKfClient) waitReplySlot(open, user string) {
	if c.config.WecomReplyMinIntervalMS == 0 {
		return
	}
	key := open + "\x00" + user
	interval := time.Duration(c.config.WecomReplyMinIntervalMS) * time.Millisecond
	c.replyMu.Lock()
	due, now := c.nextReplyAt[key], time.Now()
	if due.Before(now) {
		due = now
	}
	c.nextReplyAt[key] = due.Add(interval)
	c.replyMu.Unlock()
	if delay := time.Until(due); delay > 0 {
		time.Sleep(delay)
	}
}
func (c *WecomKfClient) syncMessages(open, callback, cursor string) ([]KfMessage, string, bool, error) {
	var result struct {
		MsgList    []KfMessage `json:"msg_list"`
		NextCursor string      `json:"next_cursor"`
		HasMore    int         `json:"has_more"`
	}
	err := c.post("kf/sync_msg", map[string]any{"open_kfid": open, "token": callback, "cursor": cursor, "limit": 1000}, &result)
	return result.MsgList, result.NextCursor, result.HasMore == 1, err
}
func (c *WecomKfClient) sendText(open, user, content, key string) error {
	c.waitReplySlot(open, user)
	return c.post("kf/send_msg", map[string]any{"touser": user, "open_kfid": open, "msgid": stableWecomMessageID("text:" + key + ":" + content), "msgtype": "text", "text": map[string]string{"content": truncateRunes(content, 2048)}}, &struct{}{})
}
func (c *WecomKfClient) sendConfirmation(open, user, content, confirm, cancel string, count int, key string) error {
	c.waitReplySlot(open, user)
	payload := map[string]any{"touser": user, "open_kfid": open, "msgid": stableWecomMessageID("menu-confirm:" + key), "msgtype": "msgmenu", "msgmenu": map[string]any{"head_content": truncateRunes(content, 1024), "list": []any{map[string]any{"type": "click", "click": map[string]string{"id": confirm, "content": fmt.Sprintf("确认打印 %d 个内容", count)}}, map[string]any{"type": "click", "click": map[string]string{"id": cancel, "content": "取消"}}}}}
	return c.post("kf/send_msg", payload, &struct{}{})
}
func (c *WecomKfClient) sendRecordMenu(open, user, content, key string) error {
	c.waitReplySlot(open, user)
	payload := map[string]any{"touser": user, "open_kfid": open, "msgid": stableWecomMessageID("record-menu:" + key + ":" + content), "msgtype": "msgmenu", "msgmenu": map[string]any{"head_content": truncateRunes(content, 1024), "list": []any{map[string]any{"type": "click", "click": map[string]string{"id": "print:records", "content": "打印记录"}}}}}
	return c.post("kf/send_msg", payload, &struct{}{})
}
func filenameFromHeader(v string) string {
	if v == "" {
		return ""
	}
	if m := regexp.MustCompile(`(?i)filename\*=UTF-8''([^;]+)`).FindStringSubmatch(v); len(m) == 2 {
		x, _ := url.QueryUnescape(m[1])
		return x
	}
	m := regexp.MustCompile(`(?i)filename="?([^";]+)"?`).FindStringSubmatch(v)
	if len(m) == 2 {
		return m[1]
	}
	return ""
}
func (c *WecomKfClient) downloadMedia(id, kind string) (PrintableFile, error) {
	var response *http.Response
	err := c.withRetry("企业微信媒体下载", func() error {
		token, err := c.token()
		if err != nil {
			return err
		}
		u := wecomAPIBase + "/media/get?" + url.Values{"access_token": {token}, "media_id": {id}}.Encode()
		response, err = c.client.Get(u)
		if err != nil {
			return err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			defer response.Body.Close()
			return &httpError{response.StatusCode}
		}
		return nil
	})
	if err != nil {
		return PrintableFile{}, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(c.config.MaxFileBytes)+1))
	if err != nil {
		return PrintableFile{}, err
	}
	if len(data) > c.config.MaxFileBytes {
		return PrintableFile{}, &ValidationError{"文件超过限制"}
	}
	if strings.Contains(response.Header.Get("Content-Type"), "application/json") {
		var x struct {
			ErrCode int    `json:"errcode"`
			ErrMsg  string `json:"errmsg"`
		}
		_ = json.Unmarshal(data, &x)
		return PrintableFile{}, &wecomAPIError{fmt.Sprintf("企业微信媒体下载失败（errcode=%d，errmsg=%s）", x.ErrCode, x.ErrMsg), retryableErrCode(x.ErrCode)}
	}
	name, mime, err := mediaMetadata(data, filenameFromHeader(response.Header.Get("Content-Disposition")), kind)
	if err != nil {
		return PrintableFile{}, err
	}
	return PrintableFile{name, mime, data}, nil
}
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
