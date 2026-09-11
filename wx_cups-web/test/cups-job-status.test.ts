import assert from 'node:assert/strict';
import test from 'node:test';
import { __test__, getJobAttributesRequest } from '../src/cups-job-status.js';

function ippResponse(jobState: number): Buffer {
  const name = Buffer.from('job-state');
  const value = Buffer.alloc(4); value.writeUInt32BE(jobState);
  const nameLength = Buffer.alloc(2); nameLength.writeUInt16BE(name.length);
  const valueLength = Buffer.alloc(2); valueLength.writeUInt16BE(value.length);
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02]),
    Buffer.from([0x23]), nameLength, name, valueLength, value, Buffer.from([0x03]),
  ]);
}

test('IPP 任务状态只将 CUPS completed 映射为完成', () => {
  assert.equal(__test__.parseJobState(ippResponse(3)), 'pending');
  assert.equal(__test__.parseJobState(ippResponse(5)), 'processing');
  assert.equal(__test__.parseJobState(ippResponse(8)), 'failed');
  assert.equal(__test__.parseJobState(ippResponse(9)), 'completed');
});

test('CUPS 查询请求使用 job URI，且只请求 job-state', () => {
  const request = getJobAttributesRequest('ipp://127.0.0.1:631/jobs/3', 42);
  assert.equal(request.readUInt16BE(2), 0x0009);
  assert.equal(request.readUInt32BE(4), 42);
  assert.match(request.toString('utf8'), /job-uri/);
  assert.match(request.toString('utf8'), /requested-attributes/);
  assert.match(request.toString('utf8'), /job-state/);
});

test('从固定打印队列生成本机 CUPS job 查询地址', () => {
  assert.deepEqual(__test__.cupsEndpoint({ printerUri: 'http://127.0.0.1:631/printers/L3150_Series_USB' } as never, 'ipp://127.0.0.1:631/jobs/3'), {
    endpoint: 'http://127.0.0.1:631/jobs/3', jobUri: 'ipp://127.0.0.1:631/jobs/3',
  });
});
