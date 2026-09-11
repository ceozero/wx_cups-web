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
  rateLimitCount: 10, rateLimitWindowMs: 600_000, requestTimeoutMs: 1000, printConfirmationTtlMs: 600_000, printStatusPollMs: 5_000, printStatusTimeoutMs: 600_000,
};

function clientWith(messages: KfMessage[], replies: string[], menus: Array<{ confirmId: string; cancelId: string }>): WecomKfClient {
  return {
    syncMessages: async () => ({ messages, nextCursor: 'cursor-1', hasMore: false }),
    sendText: async (_openKfId: string, _externalUserId: string, content: string) => { replies.push(content); },
    sendPrintConfirmationMenu: async (_openKfId: string, _externalUserId: string, confirmId: string, cancelId: string) => { menus.push({ confirmId, cancelId }); },
    downloadMedia: async () => { throw new Error('测试不应下载媒体'); },
  } as unknown as WecomKfClient;
}

test('先发送确认菜单，客户确认后才提交，并在 CUPS 完成时仅回告一次', async () => {
  const store = new MessageStore(':memory:');
  const replies: string[] = [];
  const menus: Array<{ confirmId: string; cancelId: string }> = [];
  let submissions = 0;
  const printer: PrinterSubmitter = { submit: async () => ({ jobId: ++submissions, pages: 1 }) };
  const printGateway = new PrintGateway(config, store, printer);
  const firstClient = clientWith([
    { msgid: 'staff-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 5, msgtype: 'text', text: { content: '坐席回复' } },
    { msgid: 'customer-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '请打印' } },
  ], replies, menus);
  const gateway = new WecomKfGateway(config, store, printGateway, firstClient, { getStatus: async () => 'pending' });

  await gateway.syncFromCallback('wk-1', 'callback-message-token');

  assert.equal(submissions, 0);
  assert.equal(menus.length, 1);
  assert.equal(replies.length, 0);
  const confirmedClient = clientWith([
    { msgid: 'menu-click-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '确认打印', menu_id: menus[0].confirmId } },
  ], replies, menus);
  (gateway as unknown as { kf: WecomKfClient }).kf = confirmedClient;
  await gateway.syncFromCallback('wk-1', 'callback-menu-token');

  assert.equal(submissions, 1);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /已提交 CUPS 任务/);
  assert.equal(store.listSubmittedPrintJobs().length, 1);
  (gateway as unknown as { statusClient: { getStatus: () => Promise<'completed'> } }).statusClient = { getStatus: async () => 'completed' };
  await gateway.pollPrintJobs();
  await gateway.pollPrintJobs();
  assert.equal(replies.length, 2);
  assert.match(replies[1], /CUPS 已完成任务/);
  store.close();
});

test('同步期间的新回调会在当前同步结束后再次拉取', async () => {
  const store = new MessageStore(':memory:');
  const replies: string[] = [];
  const menus: Array<{ confirmId: string; cancelId: string }> = [];
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
    sendPrintConfirmationMenu: async (_openKfId: string, _externalUserId: string, confirmId: string, cancelId: string) => { menus.push({ confirmId, cancelId }); },
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
  assert.equal(submissions, 0);
  assert.equal(replies.length, 0);
  assert.equal(menus.length, 2);
  assert.equal(store.getKfCursor('wk-1'), 'cursor-2');
  store.close();
});
