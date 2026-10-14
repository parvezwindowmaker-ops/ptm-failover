import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import './secrets.mjs';
if (!existsSync('apps/web/dist/index.html') || !existsSync('dist/server.mjs')) {
  const build = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts'],
    { stdio: 'inherit' },
  );
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) process.exit(code ?? 1);
  const serverBuild = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  const serverCode = await new Promise((resolve) => serverBuild.on('exit', resolve));
  if (serverCode !== 0) process.exit(serverCode ?? 1);
}
console.log('PTM Failover demo: http://localhost:8080 — local simulated providers and routing.');
const child = spawn(process.execPath, ['dist/server.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, DEMO_MODE: 'true', DATA_DIR: process.env.DATA_DIR ?? 'data/demo' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
