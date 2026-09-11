import assert from 'node:assert/strict';
import test from 'node:test';
import { ValidationError, sanitizeFilename, validateFile } from '../src/validation.js';

test('接受带正确 MIME 与文件头的 PDF', () => {
  const file = validateFile({ filename: 'report.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Page >>') }, 1024, 20);
  assert.equal(file.filename, 'report.pdf');
});

test('拒绝 MIME 与文件头伪装', () => {
  assert.throws(() => validateFile({ filename: 'invoice.pdf', contentType: 'application/pdf', buffer: Buffer.from('not a pdf') }, 1024, 20), ValidationError);
  assert.throws(() => validateFile({ filename: 'photo.png', contentType: 'image/jpeg', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }, 1024, 20), ValidationError);
});

test('文件名移除路径与控制字符', () => {
  const filename = sanitizeFilename('../../a\u0000b.txt');
  assert.doesNotMatch(filename, /[\\/\x00]/);
});
