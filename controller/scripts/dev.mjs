import { spawn } from 'node:child_process';
import './secrets.mjs';
const children = [
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'apps/api/src/server.ts'], {
    stdio: 'inherit',
    env: { ...process.env, APP_BASE_URL: process.env.APP_BASE_URL ?? 'http://localhost:5173' },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'], {
    stdio: 'inherit',
  }),
];
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
