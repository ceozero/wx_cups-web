import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import { PrintGateway } from '../src/gateway.js';
import { MessageStore } from '../src/store.js';
import type { PrintableFile, PrinterSubmitter } from '../src/types.js';

const config: Config = {
  cupsWebUrl: 'http://127.0.0.1:8080', cupsWebUser: 'wecom-gateway', cupsWebPassword: 'secret', printerUri: 'http://127.0.0.1:631/printers/Office_A4',
  wecomBotId: 'bot', wecomBotSecret: 'secret', allowedUsers: new Set(['alice']), dataDir: ':memory:', maxFileBytes: 1024, maxPages: 20,
  rateLimitCount: 10, rateLimitWindowMs: 600_000, requestTimeoutMs: 1000,
};

const textFile = (): PrintableFile => ({ filename: 'message.txt', contentType: 'text/plain', buffer: Buffer.from('请打印这段文字') });

test('同一 msgid 只提交一次且返回原结果', async () => {
  let submits = 0;
  const printer: PrinterSubmitter = { submit: async () => ({ jobId: ++submits, pages: 1 }) };
  const store = new MessageStore(':memory:');
  const gateway = new PrintGateway(config, store, printer);
  const message = { msgId: 'm-1', userId: 'alice', loadFiles: async () => [textFile()] };
  const first = await gateway.process(message);
  const second = await gateway.process(message);
  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'accepted');
  assert.equal(submits, 1);
  assert.match(second.reply, /已处理/);
  store.close();
});

test('网络中断记录为 uncertain 并且不自动重发', async () => {
  let submits = 0;
  const printer: PrinterSubmitter = { submit: async () => { submits += 1; const { SubmitUncertainError } = await import('../src/cups-client.js'); throw new SubmitUncertainError('timeout'); } };
  const store = new MessageStore(':memory:');
  const gateway = new PrintGateway(config, store, printer);
  const message = { msgId: 'm-timeout', userId: 'alice', loadFiles: async () => [textFile()] };
  const first = await gateway.process(message);
  const second = await gateway.process(message);
  assert.equal(first.status, 'uncertain');
  assert.equal(second.status, 'uncertain');
  assert.equal(submits, 1);
  store.close();
});

test('非白名单成员在下载文件前被拒绝', async () => {
  const store = new MessageStore(':memory:');
  const gateway = new PrintGateway(config, store, { submit: async () => ({ jobId: 1 }) });
  let downloaded = false;
  const result = await gateway.process({ msgId: 'm-denied', userId: 'mallory', loadFiles: async () => { downloaded = true; return [textFile()]; } });
  assert.equal(result.status, 'rejected');
  assert.equal(downloaded, false);
  store.close();
});
