import axios from 'axios';
import type { Config } from './config.js';

export type CupsJobState = 'pending' | 'processing' | 'completed' | 'failed' | 'unknown';

function writeU16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function writeU32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function attribute(valueTag: number, name: string, value: string): Buffer {
  const encodedName = Buffer.from(name, 'utf8');
  const encodedValue = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from([valueTag]), writeU16(encodedName.length), encodedName, writeU16(encodedValue.length), encodedValue]);
}

/** IPP Get-Job-Attributes。仅请求最终状态，避免依赖 cups-web 的历史展示状态。 */
export function getJobAttributesRequest(jobUri: string, requestId = 1): Buffer {
  return Buffer.concat([
    Buffer.from([0x02, 0x00, 0x00, 0x09]), // IPP 2.0, Get-Job-Attributes
    writeU32(requestId),
    Buffer.from([0x01]), // operation-attributes-tag
    attribute(0x47, 'attributes-charset', 'utf-8'),
    attribute(0x48, 'attributes-natural-language', 'en'),
    attribute(0x45, 'job-uri', jobUri),
    attribute(0x44, 'requested-attributes', 'job-state'),
    Buffer.from([0x03]), // end-of-attributes-tag
  ]);
}

function parseJobState(response: Buffer): CupsJobState {
  if (response.length < 8) throw new Error('CUPS 返回的 IPP 响应过短');
  const status = response.readUInt16BE(2);
  if (status !== 0x0000) {
    // 任务刚创建或历史记录已被 CUPS 清理时，稍后再查，不提前误报失败。
    if (status === 0x0406) return 'unknown';
    throw new Error(`CUPS 查询任务失败（IPP status=0x${status.toString(16)}）`);
  }
  let offset = 8;
  while (offset < response.length) {
    const tag = response[offset++];
    if (tag === 0x03) break;
    if (tag <= 0x0f) continue; // attribute-group tag
    if (offset + 4 > response.length) throw new Error('CUPS 返回的 IPP 属性损坏');
    const nameLength = response.readUInt16BE(offset); offset += 2;
    if (offset + nameLength + 2 > response.length) throw new Error('CUPS 返回的 IPP 属性名损坏');
    const name = response.subarray(offset, offset + nameLength).toString('utf8'); offset += nameLength;
    const valueLength = response.readUInt16BE(offset); offset += 2;
    if (offset + valueLength > response.length) throw new Error('CUPS 返回的 IPP 属性值损坏');
    const value = response.subarray(offset, offset + valueLength); offset += valueLength;
    if (name !== 'job-state' || value.length !== 4) continue;
    switch (value.readUInt32BE(0)) {
      case 3: case 4: return 'pending';
      case 5: case 6: return 'processing';
      case 7: case 8: return 'failed';
      case 9: return 'completed';
      default: return 'unknown';
    }
  }
  return 'unknown';
}

function cupsEndpoint(config: Config, jobId: string): { endpoint: string; jobUri: string } {
  const jobNumber = /\/jobs\/(\d+)$/.exec(jobId)?.[1];
  if (!jobNumber) throw new Error('cups-web 未返回可查询的 CUPS Job URI');
  const printer = new URL(config.printerUri);
  if (!['http:', 'https:', 'ipp:', 'ipps:'].includes(printer.protocol)) throw new Error('PRINTER_URI 协议不受支持');
  const scheme = printer.protocol === 'ipps:' || printer.protocol === 'https:' ? 'https:' : 'http:';
  const endpoint = new URL(`/jobs/${jobNumber}`, `${scheme}//${printer.host}`).toString();
  const ippScheme = scheme === 'https:' ? 'ipps:' : 'ipp:';
  return { endpoint, jobUri: `${ippScheme}//${printer.host}/jobs/${jobNumber}` };
}

export class CupsJobStatusClient {
  private requestId = 0;

  constructor(private readonly config: Config) {}

  async getStatus(jobId: string): Promise<CupsJobState> {
    const { endpoint, jobUri } = cupsEndpoint(this.config, jobId);
    const response = await axios.post<ArrayBuffer>(endpoint, getJobAttributesRequest(jobUri, ++this.requestId), {
      headers: { 'content-type': 'application/ipp' },
      responseType: 'arraybuffer',
      timeout: this.config.requestTimeoutMs,
      validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`CUPS 查询 HTTP ${response.status}`);
    return parseJobState(Buffer.from(response.data));
  }
}

export const __test__ = { parseJobState, cupsEndpoint };
