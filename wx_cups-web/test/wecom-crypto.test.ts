import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import test from 'node:test';
import { decryptWecomPayload, encryptedValue, parseWecomCallback, verifyWecomSignature } from '../src/wecom-crypto.js';

const aesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const corpId = 'ww123456';
const token = 'callback-token';

function encrypt(xml: string): string {
  const key = Buffer.from(`${aesKey}=`, 'base64');
  const source = Buffer.concat([Buffer.alloc(16, 7), Buffer.alloc(4), Buffer.from(xml), Buffer.from(corpId)]);
  source.writeUInt32BE(Buffer.byteLength(xml), 16);
  const padding = 32 - (source.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([source, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}

test('验证并解密企业微信客服回调', () => {
  const xml = '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[message-token]]></Token><OpenKfId><![CDATA[wk123]]></OpenKfId></xml>';
  const encrypted = encrypt(xml);
  const signature = createHash('sha1').update([token, '1', 'nonce', encrypted].sort().join('')).digest('hex');
  assert.equal(verifyWecomSignature(token, signature, '1', 'nonce', encrypted), true);
  const decoded = decryptWecomPayload(encrypted, aesKey, corpId);
  assert.equal(decoded, xml);
  assert.deepEqual(parseWecomCallback(decoded), { event: 'kf_msg_or_event', token: 'message-token', openKfId: 'wk123' });
  assert.equal(encryptedValue(`<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`), encrypted);
});

test('拒绝错误签名与错误 CorpID', () => {
  const encrypted = encrypt('<xml><Event>kf_msg_or_event</Event></xml>');
  assert.equal(verifyWecomSignature(token, 'bad', '1', 'nonce', encrypted), false);
  assert.throws(() => decryptWecomPayload(encrypted, aesKey, 'ww-other'), /CorpID/);
});
