import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const target = process.argv[2];
const choices = {
  esbuild: [`@esbuild/${process.platform}-${process.arch}`, '0.28.2'],
  prettier: ['prettier', '3.9.10'],
};
if (!Object.hasOwn(choices, target)) throw new Error('Supported diagnostic tools: esbuild, prettier');
const [name, version] = choices[target];
const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, {
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error('Tool metadata unavailable');
const meta = await response.json();
if (!meta.dist.tarball.startsWith('https://registry.npmjs.org/')) throw new Error('Unexpected registry host');
const data = Buffer.from(
  await fetch(meta.dist.tarball, { signal: AbortSignal.timeout(60000) }).then((r) => r.arrayBuffer()),
);
if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== meta.dist.integrity)
  throw new Error('Tool integrity verification failed');
mkdirSync(`.tools/${target}`, { recursive: true });
writeFileSync(`.tools/${target}/package.tgz`, data);
const result = spawnSync(
  process.execPath,
  ['scripts/unpack-tool.mjs', `.tools/${target}/package.tgz`, `.tools/${target}`],
  { stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Verified ${name} ${version} unpacked locally`);
