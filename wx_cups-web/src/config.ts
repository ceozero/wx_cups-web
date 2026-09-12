import { resolve } from 'node:path';

export interface Config {
  cupsWebUrl: string;
  cupsWebUser: string;
  cupsWebPassword: string;
  printerUri: string;
  wecomCorpId: string;
  wecomKfSecret: string;
  wecomCallbackToken: string;
  wecomCallbackEncodingAesKey: string;
  wecomCallbackHost: string;
  wecomCallbackPort: number;
  openKfIds: Set<string>;
  allowedExternalUsers: Set<string>;
  dataDir: string;
  maxFileBytes: number;
  maxPages: number;
  rateLimitCount: number;
  rateLimitWindowMs: number;
  requestTimeoutMs: number;
  printConfirmationTtlMs: number;
  printStatusPollMs: number;
  printStatusTimeoutMs: number;
  wecomApiMaxRetries: number;
  wecomApiRetryBaseMs: number;
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

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${name} 必须是 0 到 ${maximum} 的整数`);
  return value;
}

function callbackAesKey(env: NodeJS.ProcessEnv): string {
  const value = required(env, 'WECOM_CALLBACK_ENCODING_AES_KEY');
  if (!/^[A-Za-z0-9]{43}$/.test(value) || Buffer.from(`${value}=`, 'base64').length !== 32) {
    throw new Error('WECOM_CALLBACK_ENCODING_AES_KEY 必须是企业微信提供的 43 位密钥');
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const openKfIds = new Set(required(env, 'WECOM_OPEN_KF_IDS').split(',').map((item) => item.trim()).filter(Boolean));
  const allowedExternalUsers = new Set(required(env, 'WECOM_ALLOWED_EXTERNAL_USERS').split(',').map((item) => item.trim()).filter(Boolean));
  if (!openKfIds.size) throw new Error('WECOM_OPEN_KF_IDS 不能为空，禁止处理未授权客服账号');
  if (!allowedExternalUsers.size) throw new Error('WECOM_ALLOWED_EXTERNAL_USERS 不能为空，禁止默认放行所有微信用户');

  return {
    cupsWebUrl: required(env, 'CUPS_WEB_URL').replace(/\/$/, ''),
    cupsWebUser: required(env, 'CUPS_WEB_USER'),
    cupsWebPassword: required(env, 'CUPS_WEB_PASSWORD'),
    printerUri: required(env, 'PRINTER_URI'),
    wecomCorpId: required(env, 'WECOM_CORP_ID'),
    wecomKfSecret: required(env, 'WECOM_KF_SECRET'),
    wecomCallbackToken: required(env, 'WECOM_CALLBACK_TOKEN'),
    wecomCallbackEncodingAesKey: callbackAesKey(env),
    wecomCallbackHost: env.WECOM_CALLBACK_HOST?.trim() || '0.0.0.0',
    wecomCallbackPort: positiveInt(env, 'WECOM_CALLBACK_PORT', 3000),
    openKfIds,
    allowedExternalUsers,
    dataDir: resolve(env.GATEWAY_DATA_DIR ?? '/app/data'),
    maxFileBytes: positiveInt(env, 'MAX_FILE_BYTES', 20 * 1024 * 1024),
    maxPages: positiveInt(env, 'MAX_PAGES', 20),
    rateLimitCount: positiveInt(env, 'RATE_LIMIT_COUNT', 10),
    rateLimitWindowMs: positiveInt(env, 'RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000),
    requestTimeoutMs: positiveInt(env, 'CUPS_REQUEST_TIMEOUT_MS', 30 * 1000),
    printConfirmationTtlMs: positiveInt(env, 'PRINT_CONFIRMATION_TTL_MS', 10 * 60 * 1000),
    printStatusPollMs: positiveInt(env, 'PRINT_STATUS_POLL_MS', 5 * 1000),
    printStatusTimeoutMs: positiveInt(env, 'PRINT_STATUS_TIMEOUT_MS', 10 * 60 * 1000),
    wecomApiMaxRetries: nonNegativeInt(env, 'WECOM_API_MAX_RETRIES', 2, 5),
    wecomApiRetryBaseMs: positiveInt(env, 'WECOM_API_RETRY_BASE_MS', 500),
  };
}
