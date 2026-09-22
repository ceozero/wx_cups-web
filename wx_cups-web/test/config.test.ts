import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('读取每位微信用户对应的 cups-web API Key', () => {
  const config = loadConfig({
    CUPS_WEB_URL: 'http://127.0.0.1:8080/',
    WECOM_CUPS_API_KEYS: '{"wmAlice":"cw_ALICE","wmBob":"cw_BOB"}',
    PRINTER_URI: 'http://127.0.0.1:631/printers/Office_A4',
    WECOM_CORP_ID: 'ww123',
    WECOM_KF_SECRET: 'kf-secret',
    WECOM_CALLBACK_TOKEN: 'callback-token',
    WECOM_CALLBACK_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_OPEN_KF_IDS: 'wk123',
    WECOM_ALLOWED_EXTERNAL_USERS: 'wmAlice, wmBob',
  });
  assert.equal(config.cupsWebUrl, 'http://127.0.0.1:8080');
  assert.equal(config.cupsApiKeysByExternalUser.get('wmAlice'), 'cw_ALICE');
  assert.equal(config.cupsApiKeysByExternalUser.get('wmBob'), 'cw_BOB');
  assert.equal(config.wecomKfSecret, 'kf-secret');
  assert.deepEqual([...config.allowedExternalUsers], ['wmAlice', 'wmBob']);
  assert.equal(config.wecomApiMaxRetries, 2);
  assert.equal(config.wecomApiRetryBaseMs, 500);
  assert.equal(config.wecomApiRequestTimeoutMs, 60_000);
});

test('拒绝缺少微信白名单用户的 cups-web API Key 映射', () => {
  assert.throws(() => loadConfig({
    CUPS_WEB_URL: 'http://127.0.0.1:8080', WECOM_CUPS_API_KEYS: '{"wmAlice":"cw_ALICE"}',
    PRINTER_URI: 'http://127.0.0.1:631/printers/Office_A4', WECOM_CORP_ID: 'ww123', WECOM_KF_SECRET: 'kf-secret',
    WECOM_CALLBACK_TOKEN: 'callback-token', WECOM_CALLBACK_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_OPEN_KF_IDS: 'wk123', WECOM_ALLOWED_EXTERNAL_USERS: 'wmAlice,wmBob',
  }), /缺少白名单用户 wmBob 的 API Key/);
});

test('拒绝非 cups-web 格式的 API Key', () => {
  assert.throws(() => loadConfig({
    CUPS_WEB_URL: 'http://127.0.0.1:8080', WECOM_CUPS_API_KEYS: '{"wmAlice":"not-an-api-key"}',
    PRINTER_URI: 'http://127.0.0.1:631/printers/Office_A4', WECOM_CORP_ID: 'ww123', WECOM_KF_SECRET: 'kf-secret',
    WECOM_CALLBACK_TOKEN: 'callback-token', WECOM_CALLBACK_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_OPEN_KF_IDS: 'wk123', WECOM_ALLOWED_EXTERNAL_USERS: 'wmAlice',
  }), /必须以 cw_ 开头/);
});

test('拒绝格式错误的微信客服回调密钥', () => {
  assert.throws(() => loadConfig({
    CUPS_WEB_URL: 'http://127.0.0.1:1180', WECOM_CUPS_API_KEYS: '{"wmAlice":"cw_ALICE"}',
    PRINTER_URI: 'http://127.0.0.1:631/printers/Office_A4', WECOM_CORP_ID: 'ww123', WECOM_KF_SECRET: 'kf-secret',
    WECOM_CALLBACK_TOKEN: 'callback-token', WECOM_CALLBACK_ENCODING_AES_KEY: 'invalid', WECOM_OPEN_KF_IDS: 'wk123', WECOM_ALLOWED_EXTERNAL_USERS: 'wmAlice',
  }), /43 位密钥/);
});
