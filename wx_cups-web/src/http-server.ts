import { createServer, type IncomingMessage as HttpIncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { encryptedValue, decryptWecomPayload, parseWecomCallback, verifyWecomSignature } from './wecom-crypto.js';
import { WecomKfGateway } from './wecom-kf-gateway.js';

function query(request: HttpIncomingMessage, name: string): string | undefined {
  return new URL(request.url ?? '/', 'http://localhost').searchParams.get(name) ?? undefined;
}

function end(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function body(request: HttpIncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1024 * 1024) throw new Error('回调请求过大');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

export async function startHttpServer(config: Config, gateway: WecomKfGateway): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const signature = query(request, 'msg_signature');
      const timestamp = query(request, 'timestamp');
      const nonce = query(request, 'nonce');
      if (request.method === 'GET') {
        const encrypted = query(request, 'echostr');
        if (!encrypted || !verifyWecomSignature(config.wecomCallbackToken, signature, timestamp, nonce, encrypted)) return end(response, 401, 'invalid signature');
        return end(response, 200, decryptWecomPayload(encrypted, config.wecomCallbackEncodingAesKey, config.wecomCorpId));
      }
      if (request.method !== 'POST') return end(response, 405, 'method not allowed');
      const encrypted = encryptedValue(await body(request));
      if (!encrypted || !verifyWecomSignature(config.wecomCallbackToken, signature, timestamp, nonce, encrypted)) return end(response, 401, 'invalid signature');
      const callback = parseWecomCallback(decryptWecomPayload(encrypted, config.wecomCallbackEncodingAesKey, config.wecomCorpId));
      end(response, 200, 'success');
      if (callback.event === 'kf_msg_or_event' && callback.openKfId && callback.token) {
        void gateway.syncFromCallback(callback.openKfId, callback.token);
      }
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'wecom_callback_failed', error: errorDetail(error) }));
      if (!response.headersSent) end(response, 400, 'invalid callback');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.wecomCallbackPort, config.wecomCallbackHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.info(JSON.stringify({ level: 'info', event: 'wecom_callback_listening', host: config.wecomCallbackHost, port: config.wecomCallbackPort }));
  return server;
}
