import assert from 'node:assert/strict';
import test from 'node:test';
import { AxiosError } from 'axios';
import { isRetryableWecomError, stableWecomMessageId } from '../src/wecom-kf-client.js';

test('客服回复 msgid 对相同业务键保持稳定且符合 32 字节限制', () => {
  const first = stableWecomMessageId('reply:customer-message-1');
  assert.equal(first, stableWecomMessageId('reply:customer-message-1'));
  assert.equal(first.length, 32);
  assert.match(first, /^[a-f0-9]+$/);
  assert.notEqual(first, stableWecomMessageId('reply:customer-message-2'));
});

test('仅对网络、限流和服务端故障进行重试', () => {
  assert.equal(isRetryableWecomError(new AxiosError('timeout', 'ECONNABORTED')), true);
  assert.equal(isRetryableWecomError(new AxiosError('server error', undefined, undefined, undefined, { status: 503 } as never)), true);
  assert.equal(isRetryableWecomError(new AxiosError('bad request', undefined, undefined, undefined, { status: 400 } as never)), false);
  assert.equal(isRetryableWecomError(new Error('文件格式错误')), false);
});
