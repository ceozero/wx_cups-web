import { resolve } from 'node:path';

export interface Config {
  cupsWebUrl: string;
  cupsWebUser: string;
  cupsWebPassword: string;
  printerUri: string;
  wecomBotId: string;
  wecomBotSecret: string;
  allowedUsers: Set<string>;
  dataDir: string;
  maxFileBytes: number;
  maxPages: number;
  rateLimitCount: number;
  rateLimitWindowMs: number;
  requestTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少必填配置 ${name}`);
  return value;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowedUsers = new Set(required(env, 'WECOM_ALLOWED_USERS').split(',').map((item) => item.trim()).filter(Boolean));
  if (!allowedUsers.size) throw new Error('WECOM_ALLOWED_USERS 不能为空，禁止默认放行所有成员');

  return {
    cupsWebUrl: required(env, 'CUPS_WEB_URL').replace(/\/$/, ''),
    cupsWebUser: required(env, 'CUPS_WEB_USER'),
    cupsWebPassword: required(env, 'CUPS_WEB_PASSWORD'),
    printerUri: required(env, 'PRINTER_URI'),
    wecomBotId: required(env, 'WECOM_BOT_ID'),
    wecomBotSecret: required(env, 'WECOM_BOT_SECRET'),
    allowedUsers,
    dataDir: resolve(env.GATEWAY_DATA_DIR ?? '/app/data'),
    maxFileBytes: positiveInt(env, 'MAX_FILE_BYTES', 20 * 1024 * 1024),
    maxPages: positiveInt(env, 'MAX_PAGES', 20),
    rateLimitCount: positiveInt(env, 'RATE_LIMIT_COUNT', 10),
    rateLimitWindowMs: positiveInt(env, 'RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000),
    requestTimeoutMs: positiveInt(env, 'CUPS_REQUEST_TIMEOUT_MS', 30 * 1000),
  };
}
