import { DatabaseSync, backup } from 'node:sqlite';

// SQLite test driver with the same synchronous query/transaction surface used by Store.
// Production remains better-sqlite3; this runs real migrations/SQL without downloading an addon.
export class NativeSqlite {
  depth = 0;
  constructor(path) {
    this.connection = new DatabaseSync(path);
  }
  pragma(sql) {
    return this.connection.prepare(`PRAGMA ${sql}`).all();
  }
  exec(sql) {
    this.connection.exec(sql);
  }
  prepare(sql) {
    return this.connection.prepare(sql);
  }
  transaction(fn) {
    const run = () => {
      const depth = this.depth++;
      const savepoint = `ptm_test_${depth}`;
      this.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        this.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        this.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        if (depth !== 0) this.exec(`RELEASE ${savepoint}`);
        throw error;
      } finally {
        this.depth--;
      }
    };
    run.immediate = run;
    return run;
  }
  backup(destination) {
    return backup(this.connection, destination);
  }
  close() {
    this.connection.close();
  }
}
