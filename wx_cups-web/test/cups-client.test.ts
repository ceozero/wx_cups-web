import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Config } from '../src/config.js';
import { CupsWebClient, SubmitFailedError } from '../src/cups-client.js';

function testConfig(cupsWebUrl: string): Config {
  return {
    cupsWebUrl,
    cupsApiKeysByExternalUser: new Map([['wm-alice', 'cw_ALICE'], ['wm-bob', 'cw_BOB']]),
    printerUri: 'http://127.0.0.1:631/printers/Office_A4',
    wecomCorpId: 'ww123', wecomKfSecret: 'kf-secret', wecomCallbackToken: 'callback-token',
    wecomCallbackEncodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    wecomCallbackHost: '127.0.0.1', wecomCallbackPort: 3000, openKfIds: new Set(['wk123']),
    allowedExternalUsers: new Set(['wm-alice', 'wm-bob']), dataDir: ':memory:', maxFileBytes: 1024, maxPages: 20,
    rateLimitCount: 10, rateLimitWindowMs: 600_000, requestTimeoutMs: 1_000, printConfirmationTtlMs: 600_000,
    printStatusPollMs: 5_000, printStatusTimeoutMs: 600_000, wecomApiMaxRetries: 2, wecomApiRetryBaseMs: 500,
    wecomApiRequestTimeoutMs: 60_000,
  };
}

test('不同微信用户以各自 API Key 打印和查询 cups-web 记录，不使用 Cookie 或 CSRF', async () => {
  const seenAuthorization: string[] = [];
  const server = createServer((request, response) => {
    seenAuthorization.push(String(request.headers.authorization));
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-csrf-token'], undefined);
    if (request.url === '/api/print' && request.method === 'POST') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"jobId":"7","pages":1}');
      return;
    }
    if (request.url === '/api/print-records' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('[{"filename":"alice.txt","jobId":"7","pages":1,"status":"printed","createdAt":"2026-09-22T00:00:00Z"}]');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new CupsWebClient(testConfig(url));
    await client.submit({ filename: 'first.txt', contentType: 'text/plain', buffer: Buffer.from('first') }, 'wm-alice');
    await client.listPrintRecords('wm-bob');
    assert.deepEqual(seenAuthorization, ['Bearer cw_ALICE', 'Bearer cw_BOB']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('cups-web 拒绝 API Key 时给出明确错误', async () => {
  const server = createServer((_request, response) => response.writeHead(401).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new CupsWebClient(testConfig(url));
    await assert.rejects(
      () => client.submit({ filename: 'first.txt', contentType: 'text/plain', buffer: Buffer.from('first') }, 'wm-alice'),
      (error: unknown) => error instanceof SubmitFailedError && /API Key 无效/.test(error.message),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
