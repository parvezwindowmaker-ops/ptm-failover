import { Store } from '../apps/api/src/db.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
const destination = resolve(process.argv[2] ?? `data/backup-${Date.now()}.sqlite`);
if (existsSync(destination)) throw new Error('Backup destination already exists; choose a new filename');
const store = Store.open(process.env.DATA_DIR ?? 'data');
await store.db.backup(destination);
store.close();
console.log(
  `Consistent SQLite backup written to ${destination}. Preserve the matching master key separately.`,
);
