import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Config } from '../src/config.js';
import { CupsWebClient } from '../src/cups-client.js';

function testConfig(cupsWebUrl: string): Config {
  return {
    cupsWebUrl,
    cupsCredentialsByExternalUser: new Map([['wm-alice', { username: 'alice', password: 'secret' }]]),
    printerUri: 'http://127.0.0.1:631/printers/Office_A4',
    wecomCorpId: 'ww123', wecomKfSecret: 'kf-secret', wecomCallbackToken: 'callback-token',
    wecomCallbackEncodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    wecomCallbackHost: '127.0.0.1', wecomCallbackPort: 3000, openKfIds: new Set(['wk123']),
    allowedExternalUsers: new Set(['wm-alice']), dataDir: ':memory:', maxFileBytes: 1024, maxPages: 20,
    rateLimitCount: 10, rateLimitWindowMs: 600_000, requestTimeoutMs: 1_000, printConfirmationTtlMs: 600_000,
    printStatusPollMs: 5_000, printStatusTimeoutMs: 600_000, wecomApiMaxRetries: 2, wecomApiRetryBaseMs: 500,
    wecomApiRequestTimeoutMs: 60_000,
  };
}

test('cups-web Cookie 过期后，下一次提交会自动重新登录', async () => {
  let loginCount = 0;
  let printCount = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/login' && request.method === 'POST') {
      loginCount += 1;
      response.setHeader('Set-Cookie', [`session=session-${loginCount}; Path=/`, `csrf_token=csrf-${loginCount}; Path=/`]);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (request.url === '/api/print' && request.method === 'POST') {
      printCount += 1;
      const cookies = request.headers.cookie ?? '';
      assert.match(cookies, new RegExp(`csrf_token=csrf-${loginCount}`));
      assert.equal(request.headers['x-csrf-token'], `csrf-${loginCount}`);
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(`{"ok":true,"jobId":${printCount},"pages":1}`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new CupsWebClient(testConfig(url));
    await client.submit({ filename: 'first.txt', contentType: 'text/plain', buffer: Buffer.from('first') }, 'wm-alice');

    // 模拟 session / CSRF Cookie 到期；真实场景是 cups-web 的默认 24 小时有效期或服务重启。
    const session = (client as unknown as { sessions: Map<string, { jar: { removeAllCookies(): Promise<void> } }> }).sessions.get('wm-alice');
    await session!.jar.removeAllCookies();
    await client.submit({ filename: 'second.txt', contentType: 'text/plain', buffer: Buffer.from('second') }, 'wm-alice');

    assert.equal(loginCount, 2);
    assert.equal(printCount, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
