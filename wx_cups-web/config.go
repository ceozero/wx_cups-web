package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	CupsWebURL                                                                  string
	CupsAPIKeys                                                                 map[string]string
	PrinterURI                                                                  string
	WecomCorpID, WecomKfSecret, WecomCallbackToken, WecomCallbackEncodingAESKey string
	WecomCallbackHost                                                           string
	WecomCallbackPort                                                           int
	OpenKfIDs, AllowedExternalUsers                                             map[string]bool
	DataDir                                                                     string
	MaxFileBytes, MaxPages, RateLimitCount, RateLimitWindowMS, RequestTimeoutMS int
	PrintConfirmationTTLMS, PrintStatusPollMS, PrintStatusTimeoutMS             int
	WecomAPIMaxRetries, WecomAPIRetryBaseMS, WecomAPIRequestTimeoutMS           int
}

func required(env map[string]string, name string) (string, error) {
	v := strings.TrimSpace(env[name])
	if v == "" {
		return "", fmt.Errorf("缺少必填配置 %s", name)
	}
	return v, nil
}
func positiveInt(env map[string]string, name string, fallback int) (int, error) {
	raw := strings.TrimSpace(env[name])
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s 必须是正整数", name)
	}
	return value, nil
}
func nonNegativeInt(env map[string]string, name string, fallback, maximum int) (int, error) {
	raw := strings.TrimSpace(env[name])
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > maximum {
		return 0, fmt.Errorf("%s 必须是 0 到 %d 的整数", name, maximum)
	}
	return value, nil
}
func setValue(raw string) map[string]bool {
	result := map[string]bool{}
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result[item] = true
		}
	}
	return result
}

func loadConfigFrom(env map[string]string) (Config, error) {
	var c Config
	var err error
	if raw, e := required(env, "WECOM_OPEN_KF_IDS"); e != nil {
		return c, e
	} else {
		c.OpenKfIDs = setValue(raw)
	}
	if raw, e := required(env, "WECOM_ALLOWED_EXTERNAL_USERS"); e != nil {
		return c, e
	} else {
		c.AllowedExternalUsers = setValue(raw)
	}
	if len(c.OpenKfIDs) == 0 {
		return c, fmt.Errorf("WECOM_OPEN_KF_IDS 不能为空，禁止处理未授权客服账号")
	}
	if len(c.AllowedExternalUsers) == 0 {
		return c, fmt.Errorf("WECOM_ALLOWED_EXTERNAL_USERS 不能为空，禁止默认放行所有微信用户")
	}
	if c.CupsWebURL, err = required(env, "CUPS_WEB_URL"); err != nil {
		return c, err
	}
	c.CupsWebURL = strings.TrimSuffix(c.CupsWebURL, "/")
	if c.PrinterURI, err = required(env, "PRINTER_URI"); err != nil {
		return c, err
	}
	if c.WecomCorpID, err = required(env, "WECOM_CORP_ID"); err != nil {
		return c, err
	}
	if c.WecomKfSecret, err = required(env, "WECOM_KF_SECRET"); err != nil {
		return c, err
	}
	if c.WecomCallbackToken, err = required(env, "WECOM_CALLBACK_TOKEN"); err != nil {
		return c, err
	}
	if c.WecomCallbackEncodingAESKey, err = required(env, "WECOM_CALLBACK_ENCODING_AES_KEY"); err != nil {
		return c, err
	}
	if len(c.WecomCallbackEncodingAESKey) != 43 {
		return c, fmt.Errorf("WECOM_CALLBACK_ENCODING_AES_KEY 必须是企业微信提供的 43 位密钥")
	}
	if decoded, e := base64.StdEncoding.DecodeString(c.WecomCallbackEncodingAESKey + "="); e != nil || len(decoded) != 32 {
		return c, fmt.Errorf("WECOM_CALLBACK_ENCODING_AES_KEY 必须是企业微信提供的 43 位密钥")
	}
	rawKeys, e := required(env, "WECOM_CUPS_API_KEYS")
	if e != nil {
		return c, e
	}
	c.CupsAPIKeys = map[string]string{}
	var parsed map[string]string
	if json.Unmarshal([]byte(rawKeys), &parsed) != nil {
		return c, fmt.Errorf("WECOM_CUPS_API_KEYS 必须是有效 JSON 对象")
	}
	for user, key := range parsed {
		key = strings.TrimSpace(key)
		if !c.AllowedExternalUsers[user] {
			return c, fmt.Errorf("WECOM_CUPS_API_KEYS 包含不在白名单中的用户：%s", user)
		}
		if !strings.HasPrefix(key, "cw_") {
			return c, fmt.Errorf("WECOM_CUPS_API_KEYS 中 %s 的 API Key 必须以 cw_ 开头", user)
		}
		c.CupsAPIKeys[user] = key
	}
	for user := range c.AllowedExternalUsers {
		if c.CupsAPIKeys[user] == "" {
			return c, fmt.Errorf("WECOM_CUPS_API_KEYS 缺少白名单用户 %s 的 API Key", user)
		}
	}
	c.WecomCallbackHost = strings.TrimSpace(env["WECOM_CALLBACK_HOST"])
	if c.WecomCallbackHost == "" {
		c.WecomCallbackHost = "0.0.0.0"
	}
	if c.WecomCallbackPort, err = positiveInt(env, "WECOM_CALLBACK_PORT", 3000); err != nil {
		return c, err
	}
	if c.MaxFileBytes, err = positiveInt(env, "MAX_FILE_BYTES", 20*1024*1024); err != nil {
		return c, err
	}
	if c.MaxPages, err = positiveInt(env, "MAX_PAGES", 20); err != nil {
		return c, err
	}
	if c.RateLimitCount, err = positiveInt(env, "RATE_LIMIT_COUNT", 10); err != nil {
		return c, err
	}
	if c.RateLimitWindowMS, err = positiveInt(env, "RATE_LIMIT_WINDOW_MS", 600000); err != nil {
		return c, err
	}
	if c.RequestTimeoutMS, err = positiveInt(env, "CUPS_REQUEST_TIMEOUT_MS", 30000); err != nil {
		return c, err
	}
	if c.PrintConfirmationTTLMS, err = positiveInt(env, "PRINT_CONFIRMATION_TTL_MS", 600000); err != nil {
		return c, err
	}
	if c.PrintStatusPollMS, err = positiveInt(env, "PRINT_STATUS_POLL_MS", 5000); err != nil {
		return c, err
	}
	if c.PrintStatusTimeoutMS, err = positiveInt(env, "PRINT_STATUS_TIMEOUT_MS", 600000); err != nil {
		return c, err
	}
	if c.WecomAPIMaxRetries, err = nonNegativeInt(env, "WECOM_API_MAX_RETRIES", 2, 5); err != nil {
		return c, err
	}
	if c.WecomAPIRetryBaseMS, err = positiveInt(env, "WECOM_API_RETRY_BASE_MS", 500); err != nil {
		return c, err
	}
	if c.WecomAPIRequestTimeoutMS, err = positiveInt(env, "WECOM_API_REQUEST_TIMEOUT_MS", 60000); err != nil {
		return c, err
	}
	c.DataDir = env["GATEWAY_DATA_DIR"]
	if c.DataDir == "" {
		c.DataDir = "/app/data"
	}
	if c.DataDir != ":memory:" {
		c.DataDir, _ = filepath.Abs(c.DataDir)
	}
	return c, nil
}
func loadConfig() (Config, error) {
	env := map[string]string{}
	for _, pair := range os.Environ() {
		if k, v, ok := strings.Cut(pair, "="); ok {
			env[k] = v
		}
	}
	return loadConfigFrom(env)
}
