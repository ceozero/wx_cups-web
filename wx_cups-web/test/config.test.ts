import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('从直接环境变量读取微信客服与 cups-web 凭据', () => {
  const config = loadConfig({
    CUPS_WEB_URL: 'http://127.0.0.1:8080/',
    CUPS_WEB_USER: 'wecom-gateway',
    CUPS_WEB_PASSWORD: 'cups-password',
    PRINTER_URI: 'http://127.0.0.1:631/printers/Office_A4',
    WECOM_CORP_ID: 'ww123',
    WECOM_KF_SECRET: 'kf-secret',
    WECOM_CALLBACK_TOKEN: 'callback-token',
    WECOM_CALLBACK_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_OPEN_KF_IDS: 'wk123',
    WECOM_ALLOWED_EXTERNAL_USERS: 'wmAlice, wmBob',
  });
  assert.equal(config.cupsWebUrl, 'http://127.0.0.1:8080');
  assert.equal(config.cupsWebPassword, 'cups-password');
  assert.equal(config.wecomKfSecret, 'kf-secret');
  assert.deepEqual([...config.allowedExternalUsers], ['wmAlice', 'wmBob']);
  assert.equal(config.wecomApiMaxRetries, 2);
  assert.equal(config.wecomApiRetryBaseMs, 500);
  assert.equal(config.wecomApiRequestTimeoutMs, 60_000);
});

test('拒绝格式错误的微信客服回调密钥', () => {
  assert.throws(() => loadConfig({
    CUPS_WEB_URL: 'http://127.0.0.1:1180', CUPS_WEB_USER: 'wecom-gateway', CUPS_WEB_PASSWORD: 'cups-password',
    PRINTER_URI: 'http://127.0.0.1:631/printers/Office_A4', WECOM_CORP_ID: 'ww123', WECOM_KF_SECRET: 'kf-secret',
    WECOM_CALLBACK_TOKEN: 'callback-token', WECOM_CALLBACK_ENCODING_AES_KEY: 'invalid', WECOM_OPEN_KF_IDS: 'wk123', WECOM_ALLOWED_EXTERNAL_USERS: 'wmAlice',
  }), /43 位密钥/);
});
