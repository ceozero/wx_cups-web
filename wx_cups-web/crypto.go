package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

func sha1Sorted(parts ...string) string {
	sort.Strings(parts)
	h := sha1.New()
	_, _ = h.Write([]byte(strings.Join(parts, "")))
	return hex.EncodeToString(h.Sum(nil))
}
func safeEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func verifyWecomSignature(token, signature, timestamp, nonce, encrypted string) bool {
	return signature != "" && timestamp != "" && nonce != "" && safeEqual(sha1Sorted(token, timestamp, nonce, encrypted), signature)
}
func decryptWecomPayload(encrypted, encodingAESKey, corpID string) (string, error) {
	key, err := base64.StdEncoding.DecodeString(encodingAESKey + "=")
	if err != nil || len(key) != 32 {
		return "", fmt.Errorf("WECOM_CALLBACK_ENCODING_AES_KEY 无效")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(encrypted)
	if err != nil {
		return "", fmt.Errorf("企业微信回调密文无效")
	}
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return "", fmt.Errorf("企业微信回调密文无效")
	}
	block, _ := aes.NewCipher(key)
	plain := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, key[:aes.BlockSize]).CryptBlocks(plain, ciphertext)
	padding := int(plain[len(plain)-1])
	// 企业微信使用的 PKCS#7 填充块大小是 32；AES-CBC 的密码块仍为 16。
	// 因此填充长度可以是 17–32，不能按 aes.BlockSize(16) 限制。
	if padding == 0 || padding > 32 || padding > len(plain) {
		return "", fmt.Errorf("企业微信回调填充无效")
	}
	for _, b := range plain[len(plain)-padding:] {
		if int(b) != padding {
			return "", fmt.Errorf("企业微信回调填充无效")
		}
	}
	plain = plain[:len(plain)-padding]
	if len(plain) < 20 {
		return "", fmt.Errorf("企业微信回调内容过短")
	}
	length := int(binary.BigEndian.Uint32(plain[16:20]))
	end := 20 + length
	if end > len(plain) {
		return "", fmt.Errorf("企业微信回调消息长度无效")
	}
	if !safeEqual(string(plain[end:]), corpID) {
		return "", fmt.Errorf("企业微信回调 CorpID 不匹配")
	}
	return string(plain[20:end]), nil
}
func xmlText(xml, tag string) string {
	re := regexp.MustCompile("<" + regexp.QuoteMeta(tag) + ">(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</" + regexp.QuoteMeta(tag) + ">")
	m := re.FindStringSubmatch(xml)
	if len(m) < 3 {
		return ""
	}
	if m[1] != "" {
		return m[1]
	}
	return strings.TrimSpace(m[2])
}
func encryptedValue(xml string) string { return xmlText(xml, "Encrypt") }
func parseWecomCallback(xml string) (event, token, openKfID string) {
	return xmlText(xml, "Event"), xmlText(xml, "Token"), xmlText(xml, "OpenKfId")
}
func hasPrefix(data, prefix []byte) bool {
	return len(data) >= len(prefix) && bytes.Equal(data[:len(prefix)], prefix)
}
