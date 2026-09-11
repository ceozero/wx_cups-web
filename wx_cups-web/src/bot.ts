import AiBot from '@wecom/aibot-node-sdk';
import type { FileMessage, ImageMessage, MixedMessage, TextMessage, WsFrame } from '@wecom/aibot-node-sdk';
import type { Config } from './config.js';
import { PrintGateway } from './gateway.js';
import type { IncomingMessage, PrintableFile } from './types.js';
import { mediaMetadata } from './validation.js';

type Client = InstanceType<typeof AiBot.WSClient>;

async function reply(client: Client, frame: WsFrame, content: string): Promise<void> {
  await client.reply(frame, { msgtype: 'text', text: { content } });
}

function incoming(frame: WsFrame, loadFiles: () => Promise<PrintableFile[]>): IncomingMessage {
  if (!frame.body) throw new Error('企业微信消息体为空');
  return { msgId: frame.body.msgid, userId: frame.body.from.userid, loadFiles };
}

/** SDK 的下载接口同时完成企业微信媒体的 AES 解密；文件仅在内存中流转。 */
async function download(client: Client, url: string | undefined, aeskey: string | undefined, type: 'image' | 'file'): Promise<PrintableFile> {
  if (!url || !aeskey) throw new Error('企业微信媒体下载信息不完整');
  const { buffer, filename } = await client.downloadFile(url, aeskey);
  return { ...mediaMetadata(buffer, filename, type), buffer };
}

async function handle(client: Client, gateway: PrintGateway, frame: WsFrame, message: IncomingMessage): Promise<void> {
  try {
    await reply(client, frame, '已接收，正在提交打印任务。');
    const result = await gateway.process(message);
    await reply(client, frame, result.reply);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'message_processing_error', msgId: frame.body?.msgid, error: error instanceof Error ? error.message : 'unknown' }));
    await reply(client, frame, '处理失败，请稍后重试。');
  }
}

export function startBot(config: Config, gateway: PrintGateway): Client {
  const client = new AiBot.WSClient({
    botId: config.wecomBotId,
    secret: config.wecomBotSecret,
    logger: {
      debug: () => undefined,
      // SDK 日志可能包含回调原文；网关只记录经筛选后的结构化事件，避免泄露媒体 URL 或密钥。
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });

  client.on('message.text', (frame: WsFrame<TextMessage>) => void handle(client, gateway, frame, incoming(frame, async () => [{
    filename: 'message.txt', contentType: 'text/plain', buffer: Buffer.from(frame.body!.text.content, 'utf8'),
  }])));
  client.on('message.image', (frame: WsFrame<ImageMessage>) => void handle(client, gateway, frame, incoming(frame, async () => [await download(client, frame.body!.image.url, frame.body!.image.aeskey, 'image')])));
  client.on('message.file', (frame: WsFrame<FileMessage>) => void handle(client, gateway, frame, incoming(frame, async () => [await download(client, frame.body!.file.url, frame.body!.file.aeskey, 'file')])));
  client.on('message.mixed', (frame: WsFrame<MixedMessage>) => void handle(client, gateway, frame, incoming(frame, async () => {
    const files: PrintableFile[] = [];
    for (const [index, item] of frame.body!.mixed.msg_item.entries()) {
      if (item.msgtype === 'text' && item.text) files.push({ filename: `mixed_${index + 1}.txt`, contentType: 'text/plain', buffer: Buffer.from(item.text.content, 'utf8') });
      if (item.msgtype === 'image' && item.image) files.push(await download(client, item.image.url, item.image.aeskey, 'image'));
    }
    return files;
  })));
  client.on('message.voice', (frame) => void handle(client, gateway, frame, incoming(frame, async () => [])));
  client.on('message.video', (frame) => void handle(client, gateway, frame, incoming(frame, async () => [])));
  client.on('authenticated', () => console.info(JSON.stringify({ level: 'info', event: 'wecom_authenticated' })));
  client.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'wecom_connection_error', error: error.message })));
  client.connect();
  return client;
}
