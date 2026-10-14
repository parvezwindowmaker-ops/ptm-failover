import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Application, Origin, Probe, Incident, ProviderView, Step } from '@ptm/contracts';
import { Fault } from '../../../packages/contracts/src/fault.ts';
import type { Vault } from './security.js';

export type Row = Record<string, unknown>;
export class Store {
  db: Database.Database;
  constructor(
    path: string,
    migration = join(process.cwd(), 'apps/api/src/migrations/001_initial.sql'),
    databaseFactory?: (path: string) => Database.Database,
  ) {
    const factory =
      databaseFactory ??
      ((filename: string) => {
        const Constructor = createRequire(import.meta.url)('better-sqlite3') as typeof Database;
        return new Constructor(filename);
      });
    this.db = factory(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL)',
    );
    const directory = dirname(migration);
    for (const filename of readdirSync(directory)
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort()) {
      const version = Number(filename.split('_')[0]);
      if (!this.one('SELECT version FROM schema_migrations WHERE version=?', version))
        this.tx(() => {
          this.db.exec(readFileSync(join(directory, filename), 'utf8'));
          this.run('INSERT INTO schema_migrations VALUES(?,?)', version, Date.now());
        });
    }
    if (!this.one("SELECT key FROM settings WHERE key='location'")) this.set('location', 'Not declared');
  }
  static open(dir: string) {
    mkdirSync(dir, { recursive: true });
    return new Store(join(dir, 'ptm.sqlite'));
  }
  one<T = Row>(sql: string, ...args: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T = Row>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).run(...args);
  }
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }
  get<T>(key: string, fallback: T): T {
    const r = this.one('SELECT value FROM settings WHERE key=?', key);
    return r ? JSON.parse(r.value as string) : fallback;
  }
  set(key: string, value: unknown) {
    this.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value),
    );
  }
  audit(
    actor: string,
    action: string,
    entity: string,
    diff: unknown = {},
    correlationId: string = randomUUID(),
  ) {
    this.run(
      'INSERT INTO audit_events(actor,action,entity,diff,timestamp,correlationId) VALUES(?,?,?,?,?,?)',
      actor,
      action,
      entity,
      JSON.stringify(diff),
      Date.now(),
      correlationId,
    );
  }
  origins(id: string): Origin[] {
    return this.all('SELECT * FROM origins WHERE applicationId=? ORDER BY role DESC', id).map(
      (r) =>
        ({
          ...JSON.parse(r.config as string),
          id: r.id,
          applicationId: r.applicationId,
          observation: r.observation ? JSON.parse(r.observation as string) : null,
          power: r.power,
          healthySince: r.healthySince,
        }) as Origin,
    );
  }
  application(id: string): Application {
    const r = this.one('SELECT * FROM applications WHERE id=?', id);
    if (!r) throw new Fault('NOT_FOUND', 'Application not found', 404);
    const routing = this.one('SELECT config FROM routing_configs WHERE applicationId=?', id);
    const policy = this.one('SELECT config FROM failover_policies WHERE applicationId=?', id);
    if (!policy)
      throw new Fault(
        'POLICY_MISSING',
        'Application policy is missing; restore or reconcile configuration.',
        503,
      );
    return {
      ...r,
      demo: !!r.demo,
      automationEnabled: !!r.automationEnabled,
      policy: JSON.parse(policy.config as string),
      origins: this.origins(id),
      routing: routing ? JSON.parse(routing.config as string) : null,
    } as unknown as Application;
  }
  applications(): Application[] {
    return this.all('SELECT id FROM applications ORDER BY createdAt').map((r) =>
      this.application(r.id as string),
    );
  }
  providers(): ProviderView[] {
    return this.all('SELECT * FROM provider_connections').map(
      (r) =>
        ({
          id: r.id,
          type: r.type,
          label: r.label,
          config: JSON.parse(r.config as string),
          secretConfigured: r.type !== 'generic',
          lastValidated: r.lastValidated,
          validationState: r.validationState,
        }) as ProviderView,
    );
  }
  credentials(id: string, vault: Vault): Record<string, string> {
    const r = this.one('SELECT encryptedSecret FROM provider_connections WHERE id=?', id);
    if (!r) throw new Fault('NOT_FOUND', 'Provider not found', 404);
    return vault.decrypt(r.encryptedSecret as string, id);
  }
  recordProbe(origin: Origin, probe: Probe) {
    this.tx(() => {
      this.run(
        'INSERT INTO probe_results(originId,timestamp,success,latency,data) VALUES(?,?,?,?,?)',
        origin.id,
        probe.at,
        Number(probe.success),
        probe.latency,
        JSON.stringify(probe),
      );
      const interval = this.application(origin.applicationId).policy.intervalSeconds * 1000;
      const gap = !origin.observation || probe.at - origin.observation.at > interval * 2;
      this.run(
        'UPDATE origins SET observation=?, healthySince=? WHERE id=?',
        JSON.stringify(probe),
        probe.success ? (gap ? probe.at : (origin.healthySince ?? probe.at)) : null,
        origin.id,
      );
    });
  }
  incident(id: string) {
    const r = this.one('SELECT * FROM incidents WHERE id=?', id);
    if (!r) throw new Fault('NOT_FOUND', 'Incident not found', 404);
    return {
      ...r,
      objectiveMet: r.objectiveMet === null ? null : !!r.objectiveMet,
      cancelRequested: !!r.cancelRequested,
    } as unknown as Incident & {
      snapshot: string;
      readinessCount: number;
      bootDeadlineAt: number;
      attempts: number;
      nextAttemptAt: number;
    };
  }
  incidents(limit = 50, offset = 0): Incident[] {
    return this.all('SELECT * FROM incidents ORDER BY startedAt DESC LIMIT ? OFFSET ?', limit, offset).map(
      (r) => this.incident(r.id as string),
    );
  }
  steps(id: string): Step[] {
    return this.all('SELECT * FROM incident_steps WHERE incidentId=? ORDER BY sequence', id).map(
      (r) => ({ ...r, intent: JSON.parse(r.intent as string) }) as unknown as Step,
    );
  }
  assertEditable(id: string, revision: number) {
    const app = this.application(id);
    if (app.configurationRevision !== revision)
      throw new Fault('REVISION_CONFLICT', 'Configuration changed. Reload and review again.', 409);
    if (this.one('SELECT id FROM incidents WHERE applicationId=? AND outcome IS NULL', id))
      throw new Fault(
        'OPERATION_CONFLICT',
        'An operation is in progress. Cancel and reconcile before editing.',
        409,
      );
    return app;
  }
  guard(owner: string, now: number) {
    this.tx(() => {
      const g = this.one('SELECT * FROM controller_guard WHERE id=1');
      if (g && g.ownerId !== owner && Number(g.expiresAt) > now)
        throw new Fault('CONTROLLER_CONFLICT', 'Only one controller replica is supported.', 503);
      this.run(
        'INSERT INTO controller_guard VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET ownerId=excluded.ownerId,expiresAt=excluded.expiresAt',
        owner,
        now + 60000,
      );
    });
  }
  retention(now: number) {
    const cutoff = now - this.get('retentionDays', 7) * 86400000;
    this.tx(() => {
      this.run(
        'INSERT INTO probe_aggregates SELECT originId,(timestamp/3600000)*3600000,COUNT(*),SUM(success),SUM(latency) FROM probe_results WHERE timestamp<? GROUP BY originId,timestamp/3600000 ON CONFLICT(originId,bucket) DO UPDATE SET count=count+excluded.count,successes=successes+excluded.successes,latencySum=latencySum+excluded.latencySum',
        cutoff,
      );
      this.run('DELETE FROM probe_results WHERE timestamp<?', cutoff);
      this.run('DELETE FROM probe_aggregates WHERE bucket<?', now - 90 * 86400000);
      this.run('DELETE FROM sessions WHERE expiresAt<?', now);
    });
  }
  close() {
    this.db.close();
  }
}
