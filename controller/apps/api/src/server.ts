import { readFileSync } from 'node:fs';
import { Store } from './db.js';
import { Vault } from './security.js';
import { buildApp } from './app.js';
import { startDemoOrigins } from './demo.js';
import { deliverOutbox } from './notifications.js';

const demo = process.env.DEMO_MODE === 'true';
const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:8080';
const base = new URL(baseUrl);
if (
  process.env.NODE_ENV === 'production' &&
  base.protocol !== 'https:' &&
  !['localhost', '127.0.0.1'].includes(base.hostname)
)
  throw new Error('Production APP_BASE_URL must use HTTPS, except localhost');
if (process.env.AUTOMATION_DEFAULT && process.env.AUTOMATION_DEFAULT !== 'false')
  throw new Error('Automation must be explicitly enabled per application');
const vault = Vault.fromFile(process.env.PTM_MASTER_KEY_FILE ?? 'secrets/master-key');
const bootstrapToken = readFileSync(
  process.env.PTM_BOOTSTRAP_TOKEN_FILE ?? 'secrets/bootstrap-token',
  'utf8',
).trim();
const store = Store.open(process.env.DATA_DIR ?? 'data');
const { api, worker } = await buildApp({
  store,
  vault,
  bootstrapToken,
  demo,
  baseUrl,
  logger: true,
  serveWeb: true,
});
const fixtures = demo ? await startDemoOrigins(store) : [];
worker.start();
await worker.tick();
await api.listen({ port: Number(process.env.PORT ?? 8080), host: '0.0.0.0' });
let delivering = false;
const notifications = setInterval(() => {
  if (delivering) return;
  delivering = true;
  void deliverOutbox(store, vault, demo)
    .catch(() => {})
    .finally(() => {
      delivering = false;
    });
}, 2000);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(notifications);
  await worker.stop();
  while (delivering) await new Promise((resolve) => setTimeout(resolve, 50));
  await api.close();
  await Promise.all(fixtures.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
