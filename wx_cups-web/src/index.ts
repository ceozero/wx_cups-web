import { loadConfig } from './config.js';
import { CupsWebClient } from './cups-client.js';
import { PrintGateway } from './gateway.js';
import { startHttpServer } from './http-server.js';
import { MessageStore } from './store.js';
import { WecomKfGateway } from './wecom-kf-gateway.js';
import { WecomKfClient } from './wecom-kf-client.js';

const config = loadConfig();
const store = new MessageStore(config.dataDir);
const cupsWeb = new CupsWebClient(config);
const kfGateway = new WecomKfGateway(config, store, new PrintGateway(config, store, cupsWeb), new WecomKfClient(config), undefined, cupsWeb);
const server = await startHttpServer(config, kfGateway);
kfGateway.startBackgroundWorkers();

function shutdown(signal: string): void {
  console.info(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
  server.close(() => {
    kfGateway.stopBackgroundWorkers();
    store.close();
    process.exit(0);
  });
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
