package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type SubmitUncertainError struct{ Message string }

func (e *SubmitUncertainError) Error() string { return e.Message }

type SubmitFailedError struct{ Message string }

func (e *SubmitFailedError) Error() string { return e.Message }

type CupsWebClient struct {
	config Config
	http   *http.Client
}

func newCupsWebClient(c Config) *CupsWebClient {
	return &CupsWebClient{c, &http.Client{Timeout: time.Duration(c.RequestTimeoutMS) * time.Millisecond}}
}
func (c *CupsWebClient) request(ctx context.Context, method, path, user string, body io.Reader, contentType string) (*http.Response, error) {
	key := c.config.CupsAPIKeys[user]
	if key == "" {
		return nil, &SubmitFailedError{"未配置该微信用户对应的 cups-web API Key"}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.config.CupsWebURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return c.http.Do(req)
}
func (c *CupsWebClient) submit(file PrintableFile, user string) (PrintReceipt, error) {
	var data bytes.Buffer
	mw := multipart.NewWriter(&data)
	partHeader := textproto.MIMEHeader{}
	partHeader.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": "file", "filename": file.Filename}))
	partHeader.Set("Content-Type", file.ContentType)
	part, err := mw.CreatePart(partHeader)
	if err != nil {
		return PrintReceipt{}, err
	}
	_, _ = part.Write(file.Buffer)
	for k, v := range map[string]string{"printer": c.config.PrinterURI, "duplex": "false", "color": "false", "copies": "1", "paper_size": "A4", "print_scaling": "auto"} {
		_ = mw.WriteField(k, v)
	}
	_ = mw.Close()
	resp, err := c.request(context.Background(), http.MethodPost, "/api/print", user, &data, mw.FormDataContentType())
	if err != nil {
		return PrintReceipt{}, &SubmitUncertainError{"提交连接中断或超时，作业状态未知"}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return PrintReceipt{}, &SubmitUncertainError{"提交连接中断或超时，作业状态未知"}
	}
	var payload struct {
		OK    *bool `json:"ok"`
		JobID any   `json:"jobId"`
		Pages *int  `json:"pages"`
	}
	_ = json.Unmarshal(raw, &payload)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && (payload.OK == nil || *payload.OK) && payload.JobID != nil {
		return PrintReceipt{JobID: fmt.Sprint(payload.JobID), Pages: payload.Pages}, nil
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return PrintReceipt{}, &SubmitFailedError{"cups-web API Key 无效、已过期、已撤销或权限不足"}
	}
	if resp.StatusCode >= 500 {
		return PrintReceipt{}, &SubmitUncertainError{fmt.Sprintf("cups-web 返回 %d", resp.StatusCode)}
	}
	return PrintReceipt{}, &SubmitFailedError{fmt.Sprintf("cups-web 拒绝打印请求（HTTP %d）", resp.StatusCode)}
}
func (c *CupsWebClient) listPrintRecords(user string, limit int) ([]CupsWebPrintRecord, error) {
	resp, err := c.request(context.Background(), http.MethodGet, "/api/print-records", user, nil, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, &SubmitFailedError{"cups-web API Key 无效、已过期、已撤销或权限不足"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &SubmitFailedError{fmt.Sprintf("cups-web 查询打印记录失败（HTTP %d）", resp.StatusCode)}
	}
	var raw []struct {
		Filename  string `json:"filename"`
		JobID     string `json:"jobId"`
		Pages     int    `json:"pages"`
		Status    string `json:"status"`
		CreatedAt string `json:"createdAt"`
	}
	if json.NewDecoder(resp.Body).Decode(&raw) != nil {
		return nil, &SubmitFailedError{fmt.Sprintf("cups-web 查询打印记录失败（HTTP %d）", resp.StatusCode)}
	}
	out := make([]CupsWebPrintRecord, len(raw))
	for i, x := range raw {
		out[i] = CupsWebPrintRecord{x.Filename, x.JobID, x.Pages, x.Status, x.CreatedAt}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339, out[i].CreatedAt)
		b, _ := time.Parse(time.RFC3339, out[j].CreatedAt)
		return a.After(b)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

type CupsJobState string

const (
	CupsPending    CupsJobState = "pending"
	CupsProcessing CupsJobState = "processing"
	CupsCompleted  CupsJobState = "completed"
	CupsFailed     CupsJobState = "failed"
	CupsUnknown    CupsJobState = "unknown"
)

func u16(n int) []byte { b := make([]byte, 2); binary.BigEndian.PutUint16(b, uint16(n)); return b }
func u32(n int) []byte { b := make([]byte, 4); binary.BigEndian.PutUint32(b, uint32(n)); return b }
func ippAttr(tag byte, name, value string) []byte {
	return bytes.Join([][]byte{{tag}, u16(len(name)), []byte(name), u16(len(value)), []byte(value)}, nil)
}
func getJobAttributesRequest(jobURI string, id int) []byte {
	return bytes.Join([][]byte{{2, 0, 0, 9}, u32(id), {1}, ippAttr(0x47, "attributes-charset", "utf-8"), ippAttr(0x48, "attributes-natural-language", "en"), ippAttr(0x45, "job-uri", jobURI), ippAttr(0x44, "requested-attributes", "job-state"), {3}}, nil)
}
func parseJobState(raw []byte) (CupsJobState, error) {
	if len(raw) < 8 {
		return CupsUnknown, errors.New("CUPS 返回的 IPP 响应过短")
	}
	status := binary.BigEndian.Uint16(raw[2:4])
	if status != 0 {
		if status == 0x0406 {
			return CupsUnknown, nil
		}
		return CupsUnknown, fmt.Errorf("CUPS 查询任务失败（IPP status=0x%x）", status)
	}
	for offset := 8; offset < len(raw); {
		tag := raw[offset]
		offset++
		if tag == 3 {
			break
		}
		if tag <= 0x0f {
			continue
		}
		if offset+4 > len(raw) {
			return CupsUnknown, errors.New("CUPS 返回的 IPP 属性损坏")
		}
		nl := int(binary.BigEndian.Uint16(raw[offset:]))
		offset += 2
		if offset+nl+2 > len(raw) {
			return CupsUnknown, errors.New("CUPS 返回的 IPP 属性名损坏")
		}
		name := string(raw[offset : offset+nl])
		offset += nl
		vl := int(binary.BigEndian.Uint16(raw[offset:]))
		offset += 2
		if offset+vl > len(raw) {
			return CupsUnknown, errors.New("CUPS 返回的 IPP 属性值损坏")
		}
		value := raw[offset : offset+vl]
		offset += vl
		if name != "job-state" || len(value) != 4 {
			continue
		}
		switch binary.BigEndian.Uint32(value) {
		case 3, 4:
			return CupsPending, nil
		case 5, 6:
			return CupsProcessing, nil
		case 7, 8:
			return CupsFailed, nil
		case 9:
			return CupsCompleted, nil
		}
		return CupsUnknown, nil
	}
	return CupsUnknown, nil
}

type CupsJobStatusClient struct {
	config Config
	client *http.Client
	mu     sync.Mutex
	id     int
}

func newCupsJobStatusClient(c Config) *CupsJobStatusClient {
	return &CupsJobStatusClient{config: c, client: &http.Client{Timeout: time.Duration(c.RequestTimeoutMS) * time.Millisecond}}
}
func cupsEndpoint(printerURI, jobID string) (string, string, error) {
	m := regexp.MustCompile(`/jobs/(\d+)$`).FindStringSubmatch(jobID)
	if len(m) != 2 {
		return "", "", errors.New("cups-web 未返回可查询的 CUPS Job URI")
	}
	u, err := url.Parse(printerURI)
	if err != nil {
		return "", "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "ipp" && u.Scheme != "ipps" {
		return "", "", errors.New("PRINTER_URI 协议不受支持")
	}
	scheme := "http"
	ipp := "ipp"
	if u.Scheme == "https" || u.Scheme == "ipps" {
		scheme = "https"
		ipp = "ipps"
	}
	return scheme + "://" + u.Host + "/jobs/" + m[1], ipp + "://" + u.Host + "/jobs/" + m[1], nil
}
func (c *CupsJobStatusClient) getStatus(jobID string) (CupsJobState, error) {
	endpoint, uri, err := cupsEndpoint(c.config.PrinterURI, jobID)
	if err != nil {
		return CupsUnknown, err
	}
	c.mu.Lock()
	c.id++
	id := c.id
	c.mu.Unlock()
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(getJobAttributesRequest(uri, id)))
	if err != nil {
		return CupsUnknown, err
	}
	req.Header.Set("Content-Type", "application/ipp")
	resp, err := c.client.Do(req)
	if err != nil {
		return CupsUnknown, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return CupsUnknown, fmt.Errorf("CUPS 查询 HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return CupsUnknown, err
	}
	return parseJobState(raw)
}
func displayJobID(id string) string {
	m := regexp.MustCompile(`/jobs/(\d+)$`).FindStringSubmatch(id)
	if len(m) == 2 {
		return m[1]
	}
	return strings.TrimSpace(id)
}
func pagePtr(s string) *int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return &n
}
