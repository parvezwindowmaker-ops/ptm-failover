import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const version = '12.11.2';
const name = `@pnpm/exe.${process.platform}-${process.arch}`;
const meta = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
  signal: AbortSignal.timeout(15000),
}).then((r) => {
  if (!r.ok) throw new Error('Package manager metadata unavailable');
  return r.json();
});
if (!meta.dist.tarball.startsWith('https://registry.npmjs.org/')) throw new Error('Unexpected registry host');
const bytes = Buffer.from(
  await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(60000) }).then((r) => r.arrayBuffer()),
);
if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== meta.dist.integrity)
  throw new Error('Package manager integrity check failed');
mkdirSync('.tools/pnpm', { recursive: true });
writeFileSync('.tools/pnpm/package.tgz', bytes);
const result = spawnSync(
  process.platform === 'win32' ? 'tar.exe' : 'tar',
  ['-xzf', '.tools/pnpm/package.tgz', '-C', '.tools/pnpm'],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Verified pnpm ${version} unpacked under .tools/pnpm/package`);
