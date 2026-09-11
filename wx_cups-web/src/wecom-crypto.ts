import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

function sha1(parts: string[]): string {
  return createHash('sha1').update(parts.sort().join('')).digest('hex');
}

function equals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function xmlText(xml: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escaped}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${escaped}>`).exec(xml);
  return match?.[1] ?? match?.[2]?.trim();
}

function aesKey(value: string): Buffer {
  const key = Buffer.from(`${value}=`, 'base64');
  if (key.length !== 32) throw new Error('WECOM_CALLBACK_ENCODING_AES_KEY 无效');
  return key;
}

/** 验证企业微信回调签名，签名内容只使用密文而不记录消息正文。 */
export function verifyWecomSignature(token: string, signature: string | undefined, timestamp: string | undefined, nonce: string | undefined, encrypted: string): boolean {
  return Boolean(signature && timestamp && nonce) && equals(sha1([token, timestamp!, nonce!, encrypted]), signature!);
}

/** 解密企业微信 XML 回调，并验证明文末尾的 CorpID。 */
export function decryptWecomPayload(encrypted: string, encodingAesKey: string, corpId: string): string {
  const key = aesKey(encodingAesKey);
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  const padding = padded[padded.length - 1];
  if (!padding || padding > 32 || padding > padded.length) throw new Error('企业微信回调填充无效');
  const plain = padded.subarray(0, padded.length - padding);
  if (plain.length < 20) throw new Error('企业微信回调内容过短');
  const length = plain.readUInt32BE(16);
  const messageEnd = 20 + length;
  if (messageEnd > plain.length) throw new Error('企业微信回调消息长度无效');
  const receiveId = plain.subarray(messageEnd).toString('utf8');
  if (!equals(receiveId, corpId)) throw new Error('企业微信回调 CorpID 不匹配');
  return plain.subarray(20, messageEnd).toString('utf8');
}

export function parseWecomCallback(xml: string): { event?: string; token?: string; openKfId?: string } {
  return {
    event: xmlText(xml, 'Event'),
    token: xmlText(xml, 'Token'),
    openKfId: xmlText(xml, 'OpenKfId'),
  };
}

export function encryptedValue(xml: string): string | undefined {
  return xmlText(xml, 'Encrypt');
}
