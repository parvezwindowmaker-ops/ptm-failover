// Local diagnostic fallback for extraction on Windows. Handles regular package files only.
import { gunzipSync } from 'node:zlib';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
const archive = gunzipSync(readFileSync(process.argv[2]));
const root = resolve(process.argv[3]);
mkdirSync(root, { recursive: true });
const string = (block, start, end) => block.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
let count = 0;
for (let at = 0; at + 512 <= archive.length;) {
  const header = archive.subarray(at, at + 512);
  if (header.every((b) => b === 0)) break;
  const name = string(header, 0, 100);
  const prefix = string(header, 345, 500);
  const size = parseInt(string(header, 124, 136).trim() || '0', 8);
  const type = String.fromCharCode(header[156]);
  const relative = (prefix ? prefix + '/' : '') + name;
  const target = resolve(root, relative);
  if (!target.startsWith(root + sep)) throw new Error('Unsafe archive path');
  if (type === '0' || type === '\0') {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, archive.subarray(at + 512, at + 512 + size));
    count++;
  } else if (type === '5') mkdirSync(target, { recursive: true });
  at += 512 + Math.ceil(size / 512) * 512;
}
console.log(`Extracted ${count} regular files into the project-local tool directory`);
