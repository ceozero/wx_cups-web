import { extname } from 'node:path';
import type { PrintableFile } from './types.js';

const allowed = new Map<string, string[]>([
  ['.pdf', ['application/pdf']],
  ['.jpg', ['image/jpeg']], ['.jpeg', ['image/jpeg']], ['.png', ['image/png']], ['.gif', ['image/gif']], ['.heic', ['image/heic']],
  ['.doc', ['application/msword']], ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
  ['.xls', ['application/vnd.ms-excel']], ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']],
  ['.ppt', ['application/vnd.ms-powerpoint']], ['.pptx', ['application/vnd.openxmlformats-officedocument.presentationml.presentation']],
  ['.ofd', ['application/ofd']], ['.txt', ['text/plain']], ['.md', ['text/markdown']], ['.html', ['text/html']],
]);

export class ValidationError extends Error {}

export function sanitizeFilename(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/^\.+/, '');
  if (!cleaned || cleaned.length > 180) throw new ValidationError('文件名不合法');
  return cleaned;
}

/** 为微信纯文本生成易识别的文件名；按 Unicode 字符而非 UTF-16 长度截取。 */
export function textFilename(content: string): string {
  const preview = Array.from(content.replace(/\s+/g, ' ').trim()).slice(0, 10).join('');
  if (!preview) return 'message.txt';
  try {
    const filename = sanitizeFilename(`${preview}.txt`);
    return filename === '.txt' || !filename.endsWith('.txt') ? 'message.txt' : filename;
  } catch {
    return 'message.txt';
  }
}

function headerMatches(ext: string, buffer: Buffer): boolean {
  const header = buffer.subarray(0, 32);
  if (ext === '.pdf') return header.toString('ascii', 0, 5) === '%PDF-';
  if (ext === '.jpg' || ext === '.jpeg') return header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (ext === '.png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.gif') return header.toString('ascii', 0, 6) === 'GIF87a' || header.toString('ascii', 0, 6) === 'GIF89a';
  if (ext === '.heic') return header.subarray(4, 8).toString('ascii') === 'ftyp' && /hei[cfvx]|mif1/.test(header.toString('ascii', 8, 16));
  if (['.docx', '.xlsx', '.pptx', '.ofd'].includes(ext)) {
    if (!header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false;
    // ZIP 的中央目录保留条目路径，可阻止任意 ZIP 冒充 Office/OFD。
    const entries = buffer.toString('latin1');
    return (ext === '.docx' && entries.includes('word/')) || (ext === '.xlsx' && entries.includes('xl/')) ||
      (ext === '.pptx' && entries.includes('ppt/')) || (ext === '.ofd' && entries.includes('OFD.xml'));
  }
  if (['.doc', '.xls', '.ppt'].includes(ext)) return header.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (['.txt', '.md', '.html'].includes(ext)) return !buffer.subarray(0, 512).includes(0);
  return false;
}

function pageCount(file: PrintableFile): number | undefined {
  const ext = extname(file.filename).toLowerCase();
  if (ext === '.pdf') return (file.buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (['.jpg', '.jpeg', '.png', '.gif', '.heic'].includes(ext)) return 1;
  if (['.txt', '.md', '.html'].includes(ext)) return Math.max(1, Math.ceil(file.buffer.toString('utf8').split(/\r?\n/).length / 60));
  return undefined;
}

export function validateFile(file: PrintableFile, maxBytes: number, maxPages: number): PrintableFile {
  const filename = sanitizeFilename(file.filename);
  const ext = extname(filename).toLowerCase();
  const expectedMimes = allowed.get(ext);
  if (!expectedMimes) throw new ValidationError(`不支持 ${ext || '无扩展名'} 格式`);
  if (!file.buffer.length) throw new ValidationError('文件为空');
  if (file.buffer.length > maxBytes) throw new ValidationError(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 限制`);
  if (!expectedMimes.includes(file.contentType.toLowerCase().split(';')[0].trim())) throw new ValidationError('文件扩展名与 MIME 类型不一致');
  if (!headerMatches(ext, file.buffer)) throw new ValidationError('文件内容与声明格式不一致');
  const pages = pageCount({ ...file, filename });
  if (pages !== undefined && pages > maxPages) throw new ValidationError(`文件预计页数超过 ${maxPages} 页限制`);
  return { ...file, filename };
}

export function mediaMetadata(buffer: Buffer, filename: string | undefined, type: 'image' | 'file'): Pick<PrintableFile, 'filename' | 'contentType'> {
  if (type === 'file') {
    const safeName = sanitizeFilename(filename ?? 'file');
    const ext = extname(safeName).toLowerCase();
    const mime = allowed.get(ext)?.[0];
    if (!mime) throw new ValidationError('下载文件缺少受支持的扩展名');
    return { filename: safeName, contentType: mime };
  }
  const detected = detectType(buffer);
  if (!detected) throw new ValidationError('无法识别文件格式');
  const safeName = filename ? sanitizeFilename(filename) : `${type}_${Date.now()}${detected.ext}`;
  const extension = extname(safeName).toLowerCase();
  if (extension !== detected.ext && !(detected.ext === '.jpg' && extension === '.jpeg')) throw new ValidationError('下载文件名与文件内容不一致');
  return { filename: safeName, contentType: detected.mime };
}

function detectType(buffer: Buffer): { ext: string; mime: string } | undefined {
  const tests: Array<[string, string]> = [['.pdf', 'application/pdf'], ['.jpg', 'image/jpeg'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.heic', 'image/heic']];
  for (const [ext, mime] of tests) if (headerMatches(ext, buffer)) return { ext, mime };
  return undefined;
}
