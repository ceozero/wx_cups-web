import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('从直接环境变量读取机器人和 cups-web 凭据', () => {
  const config = loadConfig({
    CUPS_WEB_URL: 'http://127.0.0.1:8080/',
    CUPS_WEB_USER: 'wecom-gateway',
    CUPS_WEB_PASSWORD: 'cups-password',
    PRINTER_URI: 'http://127.0.0.1:631/printers/Office_A4',
    WECOM_BOT_ID: 'bot-id',
    WECOM_BOT_SECRET: 'bot-secret',
    WECOM_ALLOWED_USERS: 'alice, bob',
  });
  assert.equal(config.cupsWebUrl, 'http://127.0.0.1:8080');
  assert.equal(config.cupsWebPassword, 'cups-password');
  assert.equal(config.wecomBotSecret, 'bot-secret');
  assert.deepEqual([...config.allowedUsers], ['alice', 'bob']);
});
