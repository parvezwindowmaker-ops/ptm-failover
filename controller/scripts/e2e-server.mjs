import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const dir = process.env.PTM_E2E_DIR;
if (!dir) throw new Error('PTM_E2E_DIR required');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'master-key'), randomBytes(32).toString('hex'), { mode: 0o600 });
writeFileSync(join(dir, 'bootstrap-token'), randomBytes(32).toString('base64url'), { mode: 0o600 });
const child = spawn(process.execPath, ['dist/server.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATA_DIR: dir,
    DEMO_MODE: 'true',
    APP_BASE_URL: 'http://localhost:8080',
    PTM_MASTER_KEY_FILE: join(dir, 'master-key'),
    PTM_BOOTSTRAP_TOKEN_FILE: join(dir, 'bootstrap-token'),
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
