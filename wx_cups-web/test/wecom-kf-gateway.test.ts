import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import { PrintGateway } from '../src/gateway.js';
import { MessageStore } from '../src/store.js';
import type { PrinterSubmitter } from '../src/types.js';
import { WecomKfGateway } from '../src/wecom-kf-gateway.js';
import type { KfMessage, WecomKfClient } from '../src/wecom-kf-client.js';

const config: Config = {
  cupsWebUrl: 'http://127.0.0.1:1180', cupsWebUser: 'wecom-gateway', cupsWebPassword: 'secret', printerUri: 'http://127.0.0.1:631/printers/Office_A4',
  wecomCorpId: 'ww123', wecomKfSecret: 'kf-secret', wecomCallbackToken: 'callback-token',
  wecomCallbackEncodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', wecomCallbackHost: '127.0.0.1', wecomCallbackPort: 3000,
  openKfIds: new Set(['wk-1']), allowedExternalUsers: new Set(['wm-alice']), dataDir: ':memory:', maxFileBytes: 1024, maxPages: 20,
  rateLimitCount: 10, rateLimitWindowMs: 600_000, requestTimeoutMs: 1000,
};

function clientWith(messages: KfMessage[], replies: string[]): WecomKfClient {
  return {
    syncMessages: async () => ({ messages, nextCursor: 'cursor-1', hasMore: false }),
    sendText: async (_openKfId: string, _externalUserId: string, content: string) => { replies.push(content); },
    downloadMedia: async () => { throw new Error('测试不应下载媒体'); },
  } as unknown as WecomKfClient;
}

test('只处理 origin=3 的微信客户消息，并且每条仅回复最终结果', async () => {
  const store = new MessageStore(':memory:');
  const replies: string[] = [];
  let submissions = 0;
  const printer: PrinterSubmitter = { submit: async () => ({ jobId: ++submissions, pages: 1 }) };
  const printGateway = new PrintGateway(config, store, printer);
  const gateway = new WecomKfGateway(config, store, printGateway, clientWith([
    { msgid: 'staff-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 5, msgtype: 'text', text: { content: '坐席回复' } },
    { msgid: 'customer-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '请打印' } },
  ], replies));

  await gateway.syncFromCallback('wk-1', 'callback-message-token');

  assert.equal(submissions, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /已提交 CUPS 任务/);
  assert.equal(store.getKfCursor('wk-1'), 'cursor-1');
  store.close();
});

test('同步期间的新回调会在当前同步结束后再次拉取', async () => {
  const store = new MessageStore(':memory:');
  const replies: string[] = [];
  const callbackTokens: string[] = [];
  let submissions = 0;
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  let calls = 0;
  const client = {
    syncMessages: async (_openKfId: string, callbackToken: string) => {
      callbackTokens.push(callbackToken);
      calls += 1;
      if (calls === 1) {
        markStarted();
        await firstGate;
        return { messages: [{ msgid: 'customer-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '第一条' } }], nextCursor: 'cursor-1', hasMore: false };
      }
      return { messages: [{ msgid: 'customer-2', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '第二条' } }], nextCursor: 'cursor-2', hasMore: false };
    },
    sendText: async (_openKfId: string, _externalUserId: string, content: string) => { replies.push(content); },
    downloadMedia: async () => { throw new Error('测试不应下载媒体'); },
  } as unknown as WecomKfClient;
  const printer: PrinterSubmitter = { submit: async () => ({ jobId: ++submissions, pages: 1 }) };
  const gateway = new WecomKfGateway(config, store, new PrintGateway(config, store, printer), client);

  const first = gateway.syncFromCallback('wk-1', 'token-1');
  await firstStarted;
  const coalesced = gateway.syncFromCallback('wk-1', 'token-2');
  assert.strictEqual(coalesced, first);
  releaseFirst();
  await first;

  assert.deepEqual(callbackTokens, ['token-1', 'token-2']);
  assert.equal(submissions, 2);
  assert.equal(replies.length, 2);
  assert.equal(store.getKfCursor('wk-1'), 'cursor-2');
  store.close();
});
