import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const version = '10.9.4';
const res = await fetch(`https://registry.npmjs.org/npm/${version}`, { signal: AbortSignal.timeout(15000) });
if (!res.ok) throw new Error('npm metadata unavailable');
const meta = await res.json();
const data = Buffer.from(
  await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(60000) }).then((r) => r.arrayBuffer()),
);
if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== meta.dist.integrity)
  throw new Error('npm integrity verification failed');
mkdirSync('.tools/npm', { recursive: true });
writeFileSync('.tools/npm/package.tgz', data);
const result = spawnSync(
  process.platform === 'win32' ? 'tar.exe' : 'tar',
  ['-xzf', '.tools/npm/package.tgz', '-C', '.tools/npm'],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Verified npm ${version} unpacked locally`);
