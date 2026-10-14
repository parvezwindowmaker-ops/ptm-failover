import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
mkdirSync('secrets', { recursive: true, mode: 0o700 });
for (const [name, value] of [
  ['master-key', randomBytes(32).toString('hex')],
  ['bootstrap-token', randomBytes(32).toString('base64url')],
]) {
  if (!existsSync(`secrets/${name}`))
    writeFileSync(`secrets/${name}`, value + '\n', { mode: 0o600, flag: 'wx' });
}
console.log(
  'Secret files are ready in ./secrets. Existing keys were preserved. Open the bootstrap-token file privately for setup; values are never printed.',
);
