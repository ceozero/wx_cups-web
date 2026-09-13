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
  rateLimitCount: 10, rateLimitWindowMs: 600_000, requestTimeoutMs: 1000, printConfirmationTtlMs: 600_000, printStatusPollMs: 5_000, printStatusTimeoutMs: 600_000, wecomApiMaxRetries: 2, wecomApiRetryBaseMs: 500, wecomApiRequestTimeoutMs: 60_000,
};

function clientWith(
  messages: KfMessage[], replies: string[], menus: Array<{ content: string; confirmId: string; cancelId: string; count: number }>, taskMenus: string[],
): WecomKfClient {
  return {
    syncMessages: async () => ({ messages, nextCursor: 'cursor-1', hasMore: false }),
    sendText: async (_openKfId: string, _externalUserId: string, content: string) => { replies.push(content); },
    sendPrintConfirmationMenu: async (_openKfId: string, _externalUserId: string, content: string, confirmId: string, cancelId: string, count: number) => { menus.push({ content, confirmId, cancelId, count }); },
    sendPrintRecordMenu: async (_openKfId: string, _externalUserId: string, content: string) => { taskMenus.push(content); },
    downloadMedia: async () => { throw new Error('测试不应下载媒体'); },
  } as unknown as WecomKfClient;
}

test('先发送确认菜单，客户确认后才提交，并在 CUPS 完成时仅回告一次', async () => {
  const store = new MessageStore(':memory:');
  const replies: string[] = [];
  const menus: Array<{ content: string; confirmId: string; cancelId: string; count: number }> = [];
  const taskMenus: string[] = [];
  let submissions = 0;
  const printer: PrinterSubmitter = { submit: async () => ({ jobId: ++submissions, pages: 1 }) };
  const printGateway = new PrintGateway(config, store, printer);
  const firstClient = clientWith([
    { msgid: 'staff-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 5, msgtype: 'text', text: { content: '坐席回复' } },
    { msgid: 'customer-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '请打印' } },
  ], replies, menus, taskMenus);
  const gateway = new WecomKfGateway(config, store, printGateway, firstClient, { getStatus: async () => 'pending' });

  await gateway.syncFromCallback('wk-1', 'callback-message-token');

  assert.equal(submissions, 0);
  assert.equal(menus.length, 1);
  assert.match(menus[0].content, /^如需打印更多，继续发送打印内容\n已收到打印内容，请确认是否打印：\n\n1\. 请打印\.txt/);
  assert.equal(menus[0].count, 1);
  assert.equal(replies.length, 0);
  const confirmedClient = clientWith([
    { msgid: 'menu-click-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '确认打印', menu_id: menus[0].confirmId } },
  ], replies, menus, taskMenus);
  (gateway as unknown as { kf: WecomKfClient }).kf = confirmedClient;
  await gateway.syncFromCallback('wk-1', 'callback-menu-token');

  assert.equal(submissions, 1);
  assert.equal(taskMenus.length, 1);
  assert.match(taskMenus[0], /已提交 CUPS 打印任务/);
  assert.equal(store.listSubmittedPrintJobs().length, 1);
  (gateway as unknown as { statusClient: { getStatus: () => Promise<'completed'> } }).statusClient = { getStatus: async () => 'completed' };
  await gateway.pollPrintJobs();
  await gateway.pollPrintJobs();
  assert.equal(taskMenus.length, 2);
  assert.match(taskMenus[1], /CUPS 已完成打印任务/);
  store.addPrintHistory({ messageId: 'other-user-print', userId: 'wm-bob', filename: 'other.pdf', jobId: '2', pages: 1 });
  const recordsClient = clientWith([
    { msgid: 'records-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '打印记录', menu_id: 'print:records' } },
  ], replies, menus, taskMenus);
  (gateway as unknown as { kf: WecomKfClient }).kf = recordsClient;
  await gateway.syncFromCallback('wk-1', 'callback-records-token');
  assert.match(replies.at(-1)!, /最近 1 条打印记录：[\s\S]*请打印\.txt · 已完成 · 任务 1/);
  assert.doesNotMatch(replies.at(-1)!, /other\.pdf/);
  store.close();
});

test('连续发送内容时菜单展示整个批次，旧菜单不能只确认部分内容', async () => {
  const store = new MessageStore(':memory:');
  const replies: string[] = [];
  const menus: Array<{ content: string; confirmId: string; cancelId: string; count: number }> = [];
  const taskMenus: string[] = [];
  let submissions = 0;
  const printer: PrinterSubmitter = { submit: async () => ({ jobId: ++submissions, pages: 1 }) };
  const firstClient = clientWith([
    { msgid: 'customer-1', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '第一份' } },
    { msgid: 'customer-2', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '第二份' } },
  ], replies, menus, taskMenus);
  const gateway = new WecomKfGateway(config, store, new PrintGateway(config, store, printer), firstClient, { getStatus: async () => 'pending' });

  await gateway.syncFromCallback('wk-1', 'callback-content-token');
  assert.equal(menus.length, 2);
  assert.match(menus[1].content, /^如需打印更多，继续发送打印内容\n已收到打印内容，请确认是否打印：\n\n1\. 第一份\.txt\n2\. 第二份\.txt/);
  assert.equal(menus[1].count, 2);

  const staleClient = clientWith([
    { msgid: 'old-menu', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '确认打印 1 个内容', menu_id: menus[0].confirmId } },
  ], replies, menus, taskMenus);
  (gateway as unknown as { kf: WecomKfClient }).kf = staleClient;
  await gateway.syncFromCallback('wk-1', 'callback-stale-token');
  assert.equal(submissions, 0);
  assert.match(replies.at(-1)!, /使用最新的确认菜单/);

  const latestClient = clientWith([
    { msgid: 'latest-menu', open_kfid: 'wk-1', external_userid: 'wm-alice', origin: 3, msgtype: 'text', text: { content: '确认打印 2 个内容', menu_id: menus[1].confirmId } },
  ], replies, menus, taskMenus);
  (gateway as unknown as { kf: WecomKfClient }).kf = latestClient;
  await gateway.syncFromCallback('wk-1', 'callback-latest-token');
  assert.equal(submissions, 2);
  assert.match(taskMenus.at(-1)!, /^已提交 CUPS 打印任务 1（1 页）、2（1 页）。该状态仅表示任务已被接收，不代表已经出纸。$/);
  (gateway as unknown as { statusClient: { getStatus: () => Promise<'completed'> } }).statusClient = { getStatus: async () => 'completed' };
  await gateway.pollPrintJobs();
  assert.equal(taskMenus.length, 2);
  assert.match(taskMenus.at(-1)!, /CUPS 已完成打印任务 1、2。请以实际出纸为准。/);
  store.close();
});

test('同步期间的新回调会在当前同步结束后再次拉取', async () => {
  const store = new MessageStore(':memory:');
  const replies: string[] = [];
  const menus: Array<{ content: string; confirmId: string; cancelId: string; count: number }> = [];
  const taskMenus: string[] = [];
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
    sendPrintConfirmationMenu: async (_openKfId: string, _externalUserId: string, content: string, confirmId: string, cancelId: string, count: number) => { menus.push({ content, confirmId, cancelId, count }); },
    sendPrintRecordMenu: async (_openKfId: string, _externalUserId: string, content: string) => { taskMenus.push(content); },
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
