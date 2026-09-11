import { loadConfig } from './config.js';
import { startBot } from './bot.js';
import { CupsWebClient } from './cups-client.js';
import { PrintGateway } from './gateway.js';
import { MessageStore } from './store.js';

const config = loadConfig();
const store = new MessageStore(config.dataDir);
const bot = startBot(config, new PrintGateway(config, store, new CupsWebClient(config)));

function shutdown(signal: string): void {
  console.info(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
  bot.disconnect();
  store.close();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
