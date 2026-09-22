package main

import (
	"bytes"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

var allowedTypes = map[string][]string{".pdf": {"application/pdf"}, ".jpg": {"image/jpeg"}, ".jpeg": {"image/jpeg"}, ".png": {"image/png"}, ".gif": {"image/gif"}, ".heic": {"image/heic"}, ".doc": {"application/msword"}, ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}, ".xls": {"application/vnd.ms-excel"}, ".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, ".ppt": {"application/vnd.ms-powerpoint"}, ".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"}, ".ofd": {"application/ofd"}, ".txt": {"text/plain"}, ".md": {"text/markdown"}, ".html": {"text/html"}}
var invalidFilename = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f\x7f]`)

func sanitizeFilename(name string) (string, error) {
	cleaned := invalidFilename.ReplaceAllString(name, "_")
	cleaned = strings.TrimLeft(cleaned, ".")
	if cleaned == "" || utf8.RuneCountInString(cleaned) > 180 {
		return "", &ValidationError{"文件名不合法"}
	}
	return cleaned, nil
}
func textFilename(content string) string {
	preview := []rune(strings.Join(strings.Fields(content), " "))
	if len(preview) > 10 {
		preview = preview[:10]
	}
	if len(preview) == 0 {
		return "message.txt"
	}
	name, err := sanitizeFilename(string(preview) + ".txt")
	if err != nil || name == ".txt" || !strings.HasSuffix(name, ".txt") {
		return "message.txt"
	}
	return name
}
func headerMatches(ext string, data []byte) bool {
	head := data
	if len(head) > 32 {
		head = head[:32]
	}
	switch ext {
	case ".pdf":
		return hasPrefix(head, []byte("%PDF-"))
	case ".jpg", ".jpeg":
		return hasPrefix(head, []byte{0xff, 0xd8, 0xff})
	case ".png":
		return hasPrefix(head, []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a})
	case ".gif":
		return hasPrefix(head, []byte("GIF87a")) || hasPrefix(head, []byte("GIF89a"))
	case ".heic":
		return len(head) >= 16 && string(head[4:8]) == "ftyp" && regexp.MustCompile(`hei[cfvx]|mif1`).Match(head[8:16])
	case ".docx", ".xlsx", ".pptx", ".ofd":
		if !hasPrefix(head, []byte{0x50, 0x4b, 0x03, 0x04}) {
			return false
		}
		s := string(data)
		return (ext == ".docx" && strings.Contains(s, "word/")) || (ext == ".xlsx" && strings.Contains(s, "xl/")) || (ext == ".pptx" && strings.Contains(s, "ppt/")) || (ext == ".ofd" && strings.Contains(s, "OFD.xml"))
	case ".doc", ".xls", ".ppt":
		return hasPrefix(head, []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1})
	case ".txt", ".md", ".html":
		slice := data
		if len(slice) > 512 {
			slice = slice[:512]
		}
		return !bytes.Contains(slice, []byte{0})
	}
	return false
}
func pageCount(file PrintableFile) (int, bool) {
	ext := strings.ToLower(filepath.Ext(file.Filename))
	switch ext {
	case ".pdf":
		return len(regexp.MustCompile(`/Type\s*/Page\b`).FindAll(file.Buffer, -1)), true
	case ".jpg", ".jpeg", ".png", ".gif", ".heic":
		return 1, true
	case ".txt", ".md", ".html":
		return max(1, (len(regexp.MustCompile(`\r?\n`).Split(string(file.Buffer), -1))+59)/60), true
	}
	return 0, false
}
func validateFile(file PrintableFile, maxBytes, maxPages int) (PrintableFile, error) {
	name, err := sanitizeFilename(file.Filename)
	if err != nil {
		return file, err
	}
	ext := strings.ToLower(filepath.Ext(name))
	expected, ok := allowedTypes[ext]
	if !ok {
		return file, &ValidationError{fmt.Sprintf("不支持 %s 格式", func() string {
			if ext == "" {
				return "无扩展名"
			}
			return ext
		}())}
	}
	if len(file.Buffer) == 0 {
		return file, &ValidationError{"文件为空"}
	}
	if len(file.Buffer) > maxBytes {
		return file, &ValidationError{fmt.Sprintf("文件超过 %d MB 限制", maxBytes/1024/1024)}
	}
	contentType := strings.TrimSpace(strings.Split(file.ContentType, ";")[0])
	matched := false
	for _, v := range expected {
		if strings.EqualFold(v, contentType) {
			matched = true
		}
	}
	if !matched {
		return file, &ValidationError{"文件扩展名与 MIME 类型不一致"}
	}
	if !headerMatches(ext, file.Buffer) {
		return file, &ValidationError{"文件内容与声明格式不一致"}
	}
	file.Filename = name
	if p, ok := pageCount(file); ok && p > maxPages {
		return file, &ValidationError{fmt.Sprintf("文件预计页数超过 %d 页限制", maxPages)}
	}
	return file, nil
}
func mediaMetadata(data []byte, filename, kind string) (string, string, error) {
	if kind == "file" {
		name, err := sanitizeFilename(filename)
		if err != nil {
			return "", "", err
		}
		mime := allowedTypes[strings.ToLower(filepath.Ext(name))]
		if len(mime) == 0 {
			return "", "", &ValidationError{"下载文件缺少受支持的扩展名"}
		}
		return name, mime[0], nil
	}
	detectedExt, detectedMIME := "", ""
	for _, x := range []struct{ e, m string }{{".pdf", "application/pdf"}, {".jpg", "image/jpeg"}, {".png", "image/png"}, {".gif", "image/gif"}, {".heic", "image/heic"}} {
		if headerMatches(x.e, data) {
			detectedExt, detectedMIME = x.e, x.m
			break
		}
	}
	if detectedExt == "" {
		return "", "", &ValidationError{"无法识别文件格式"}
	}
	if filename == "" {
		return "image" + detectedExt, detectedMIME, nil
	}
	name, err := sanitizeFilename(filename)
	if err != nil {
		return "", "", err
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext != detectedExt && !(detectedExt == ".jpg" && ext == ".jpeg") {
		return "", "", &ValidationError{"下载文件名与文件内容不一致"}
	}
	return name, detectedMIME, nil
}
