package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testEnv() map[string]string {
	return map[string]string{"CUPS_WEB_URL": "http://127.0.0.1:1180/", "PRINTER_URI": "http://127.0.0.1:631/printers/Office_A4", "WECOM_CORP_ID": "wwtest", "WECOM_KF_SECRET": "secret", "WECOM_CALLBACK_TOKEN": "token", "WECOM_CALLBACK_ENCODING_AES_KEY": "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "WECOM_OPEN_KF_IDS": "wk1", "WECOM_ALLOWED_EXTERNAL_USERS": "wm1", "WECOM_CUPS_API_KEYS": "{\"wm1\":\"cw_key\"}", "GATEWAY_DATA_DIR": ":memory:"}
}
func TestLoadConfigAndAPIKeyCoverage(t *testing.T) {
	env := testEnv()
	c, err := loadConfigFrom(env)
	if err != nil {
		t.Fatal(err)
	}
	if c.CupsWebURL != "http://127.0.0.1:1180" || c.CupsAPIKeys["wm1"] != "cw_key" {
		t.Fatalf("配置解析错误: %#v", c)
	}
	env["WECOM_CUPS_API_KEYS"] = "{}"
	if _, err = loadConfigFrom(env); err == nil || !strings.Contains(err.Error(), "缺少白名单用户") {
		t.Fatalf("应拒绝缺少 API Key: %v", err)
	}
}
func encryptForTest(plain, key, receive string) string {
	raw := make([]byte, 16)
	_, _ = rand.Read(raw)
	msg := append(raw, make([]byte, 4)...)
	binary.BigEndian.PutUint32(msg[16:], uint32(len(plain)))
	msg = append(msg, []byte(plain)...)
	msg = append(msg, []byte(receive)...)
	padding := aes.BlockSize - len(msg)%aes.BlockSize
	msg = append(msg, bytesRepeat(byte(padding), padding)...)
	decoded, _ := base64.StdEncoding.DecodeString(key + "=")
	block, _ := aes.NewCipher(decoded)
	out := make([]byte, len(msg))
	cipher.NewCBCEncrypter(block, decoded[:aes.BlockSize]).CryptBlocks(out, msg)
	return base64.StdEncoding.EncodeToString(out)
}
func bytesRepeat(v byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = v
	}
	return out
}
func TestCallbackCryptoRoundTrip(t *testing.T) {
	key := testEnv()["WECOM_CALLBACK_ENCODING_AES_KEY"]
	encrypted := encryptForTest("<xml><Event>kf_msg_or_event</Event><Token>abc</Token></xml>", key, "wwtest")
	plain, err := decryptWecomPayload(encrypted, key, "wwtest")
	if err != nil || !strings.Contains(plain, "kf_msg_or_event") {
		t.Fatalf("解密失败: %v %s", err, plain)
	}
	sig := sha1Sorted("token", "1", "2", encrypted)
	if !verifyWecomSignature("token", sig, "1", "2", encrypted) {
		t.Fatal("签名应通过")
	}
	if verifyWecomSignature("token", "bad", "1", "2", encrypted) {
		t.Fatal("错误签名不应通过")
	}
}
func TestValidationAndTextFilename(t *testing.T) {
	f, err := validateFile(PrintableFile{"a.pdf", "application/pdf", []byte("%PDF-1.7\n/Type /Page")}, 1024, 1)
	if err != nil || f.Filename != "a.pdf" {
		t.Fatalf("PDF 校验失败: %v", err)
	}
	if _, err = validateFile(PrintableFile{"a.pdf", "application/pdf", []byte("not pdf")}, 1024, 1); err == nil {
		t.Fatal("伪造 PDF 应失败")
	}
	if got := textFilename(" 你好   世界 \n test"); got != "你好 世界 test.txt" {
		t.Fatalf("文本文件名错误: %q", got)
	}
}
func TestStorePendingBatchAndRestartRecovery(t *testing.T) {
	s, err := newStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p := PendingPrint{MsgID: "m1", UserID: "u", OpenKfID: "k", Kind: "text", Payload: "x", ExpiresAt: nowMillis() + 60000}
	created, err := s.createPending(p)
	if err != nil || !created {
		t.Fatal(err)
	}
	items, ok, err := s.confirmPending("m1", "u", "k")
	if err != nil || !ok || len(items) != 1 {
		t.Fatalf("确认批次失败: %v %v %d", err, ok, len(items))
	}
	created, err = s.createPending(PendingPrint{MsgID: "m2", UserID: "u", OpenKfID: "k", Kind: "text", Payload: "x", ExpiresAt: nowMillis() + 60000})
	if err != nil || !created {
		t.Fatal(err)
	}
	ok, err = s.cancelPending("m2", "u", "k")
	if err != nil || !ok {
		t.Fatalf("取消批次失败: %v", err)
	}
}
func TestIPPRequestAndResponseParsing(t *testing.T) {
	request := getJobAttributesRequest("ipp://printer/jobs/7", 4)
	if len(request) < 8 || binary.BigEndian.Uint32(request[4:8]) != 4 {
		t.Fatal("IPP 请求编号错误")
	}
	response := append([]byte{2, 0, 0, 0, 0, 0, 0, 1, 1, 0x21, 0, 9}, []byte("job-state")...)
	response = append(response, 0, 4, 0, 0, 0, 9, 3)
	state, err := parseJobState(response)
	if err != nil || state != CupsCompleted {
		t.Fatalf("IPP 状态解析失败: %v %s", err, state)
	}
}

func TestKfMessageJSONUsesWecomFieldNames(t *testing.T) {
	var message KfMessage
	err := json.Unmarshal([]byte(`{"msgid":"m1","external_userid":"wm1","open_kfid":"wk1","origin":3,"msgtype":"text","text":{"content":"hello","menu_id":"print:records"}}`), &message)
	if err != nil || message.ExternalUserID != "wm1" || message.OpenKfID != "wk1" || message.Text == nil || message.Text.MenuID != "print:records" {
		t.Fatalf("企业微信字段映射错误: %#v, %v", message, err)
	}
}

func TestCupsSubmitUsesMappedAPIKeyAndFileContentType(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/print" || r.Header.Get("Authorization") != "Bearer cw_key" {
			t.Fatalf("请求认证或路径错误: %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := r.ParseMultipartForm(1024 * 1024); err != nil || r.FormValue("printer") == "" || r.FormValue("paper_size") != "A4" {
			t.Fatalf("打印字段错误: %v", err)
		}
		file, header, err := r.FormFile("file")
		if err != nil || header.Header.Get("Content-Type") != "text/plain" {
			t.Fatalf("文件 MIME 错误: %v, %#v", err, header)
		}
		defer file.Close()
		body, _ := io.ReadAll(file)
		if string(body) != "hello" {
			t.Fatalf("文件内容错误: %q", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"jobId":"http://cups/jobs/7","pages":1}`))
	}))
	defer server.Close()
	c, err := loadConfigFrom(testEnv())
	if err != nil {
		t.Fatal(err)
	}
	c.CupsWebURL = server.URL
	receipt, err := newCupsWebClient(c).submit(PrintableFile{"hello.txt", "text/plain", []byte("hello")}, "wm1")
	if err != nil || receipt.JobID != "http://cups/jobs/7" || receipt.Pages == nil || *receipt.Pages != 1 {
		t.Fatalf("cups-web 提交失败: %#v, %v", receipt, err)
	}
}
