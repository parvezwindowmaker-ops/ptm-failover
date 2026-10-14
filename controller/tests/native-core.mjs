import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../apps/api/src/db.ts';
import { Orchestrator } from '../packages/orchestrator/src/index.ts';
import { routesEqual, targetRecords } from '../packages/routing/src/plan.ts';
import { Fault } from '../packages/contracts/src/fault.ts';
import { providerRequest, ProviderHttpError } from '../packages/providers/src/http.ts';
import { NativeSqlite } from './native-sqlite.mjs';

const factory = (path) => new NativeSqlite(path);
function fixture(path = ':memory:', existingId = null) {
  const store = new Store(path, undefined, factory);
  let now = Date.now();
  const id = existingId ?? randomUUID();
  if (!existingId) {
    store.run(
      'INSERT INTO applications(id,name,publicHostname,desiredRelease,demo,createdAt) VALUES(?,?,?,?,?,?)',
      id,
      'Native SQL test',
      `${id}.example.com`,
      'v1',
      1,
      now,
    );
    for (const [index, role] of ['primary', 'backup'].entries()) {
      const oid = randomUUID();
      const config = {
        role,
        providerConnectionId: null,
        resourceId: oid,
        address: '8.8.8.8',
        tlsHostname: `${id}.example.com`,
        protocol: 'https',
        port: 443,
        readinessPath: '/ready',
        expectedStatus: 200,
        expectedIdentity: role,
        releasePolicy: 'exact',
        startOnFailure: role === 'backup',
        approvedPrivateCidrs: [],
        assertions: {},
        ipv4: `8.8.8.${index + 1}`,
      };
      store.run(
        'INSERT INTO origins(id,applicationId,role,config) VALUES(?,?,?,?)',
        oid,
        id,
        role,
        JSON.stringify(config),
      );
    }
    const origins = store.origins(id);
    store.run(
      'UPDATE applications SET activeOriginId=?,automationEnabled=1 WHERE id=?',
      origins.find((o) => o.role === 'primary').id,
      id,
    );
    const policy = {
      intervalSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 3,
      readinessSuccesses: 2,
      bootDeadlineSeconds: 30,
      objectiveSeconds: 60,
      cooldownSeconds: 0,
      failbackHealthySeconds: 5,
      confirmation: 'single-vantage',
      maintenance: false,
    };
    store.run('INSERT INTO failover_policies VALUES(?,?)', id, JSON.stringify(policy));
    store.run(
      'INSERT INTO routing_configs VALUES(?,?,?)',
      id,
      null,
      JSON.stringify({
        type: 'demo',
        providerConnectionId: null,
        zoneId: '',
        recordIds: [],
        dnsOnlyAcknowledged: false,
        revision: 1,
        snapshot: [
          { id: 'a', type: 'A', name: `${id}.example.com`, content: '8.8.8.1', proxied: true, ttl: 1 },
        ],
      }),
    );
  }
  const app = store.application(id);
  let records = structuredClone(app.routing.snapshot);
  let starts = 0,
    writes = 0;
  const health = {
    primary: true,
    backup: true,
    dependency: true,
    publicIdentity: true,
    running: true,
    crashStart: false,
    crashRoute: false,
    partial: false,
  };
  const router = {
    async readRoute() {
      return records;
    },
    async validateConfiguration() {
      return records;
    },
    async planSwitch(target, approved) {
      if (!routesEqual(records, approved, true))
        throw new Fault('RECONCILIATION_REQUIRED', 'External edit', 409);
      return targetRecords(target, approved);
    },
    async applySwitch(plan, fence) {
      fence();
      writes++;
      records = health.partial ? [plan[0], ...records.slice(1)] : plan;
      if (health.crashRoute) throw new Fault('PROVIDER_OUTCOME_UNKNOWN', 'Unknown', 502, true);
    },
    async inspectConvergence(plan) {
      return routesEqual(records, plan);
    },
  };
  const runtime = {
    provider() {
      return {
        capabilities() {
          return { inspect: true, start: true };
        },
        async inspectResource(resourceId) {
          return {
            id: resourceId,
            name: resourceId,
            power: health.running ? 'running' : 'stopped',
            addresses: [],
          };
        },
        async startResource() {
          starts++;
          health.running = true;
          if (health.crashStart) throw new Fault('PROVIDER_OUTCOME_UNKNOWN', 'Unknown', 502, true);
          return { requestId: 'native-start' };
        },
      };
    },
    router() {
      return router;
    },
    async probe(_app, origin, publicRoute = false) {
      const success =
        health[origin.role] &&
        health.dependency &&
        (origin.role === 'primary' || health.running) &&
        (!publicRoute || health.publicIdentity);
      return {
        at: now,
        success,
        status: success ? 200 : 503,
        latency: 2,
        reason: success
          ? null
          : !health.dependency
            ? 'SHARED_DEPENDENCY_FAILED'
            : publicRoute
              ? 'IDENTITY_MISMATCH'
              : 'UNREADY',
        identity: success ? origin.expectedIdentity : null,
        release: 'v1',
      };
    },
  };
  const worker = new Orchestrator(store, runtime, () => now);
  return {
    store,
    app,
    worker,
    runtime,
    health,
    get now() {
      return now;
    },
    get starts() {
      return starts;
    },
    get writes() {
      return writes;
    },
    get records() {
      return records;
    },
    edit(value) {
      records = value;
    },
    jump(ms) {
      now += ms;
    },
    create(key = randomUUID()) {
      return worker.create(id, 'backup', 'worker', key, app.configurationRevision, 'single-vantage');
    },
    async advance(incidentId, ticks = 10) {
      for (let t = 0; t < ticks; t++) {
        await worker.advance(incidentId);
        now += 2500;
      }
    },
  };
}
test('healthy and transient failures do not route traffic', async () => {
  const h = fixture();
  await h.worker.tick();
  h.health.primary = false;
  h.jump(3000);
  await h.worker.tick();
  h.health.primary = true;
  h.jump(3000);
  await h.worker.tick();
  assert.equal(h.writes, 0);
  assert.equal(h.store.incidents().length, 0);
  h.store.close();
});
test('three confirmed failures recover to an already-running backup without a start', async () => {
  const h = fixture();
  h.health.primary = false;
  for (let t = 0; t < 3; t++) {
    await h.worker.tick();
    h.jump(3000);
  }
  const incident = h.store.incidents()[0];
  assert.ok(incident);
  await h.advance(incident.id);
  assert.equal(h.starts, 0);
  assert.equal(h.writes, 1);
  assert.equal(h.store.incident(incident.id).outcome, 'recovered');
  assert.equal(h.store.incident(incident.id).objectiveMet, true);
  h.health.primary = true;
  h.jump(3000);
  await h.worker.tick();
  assert.equal(h.writes, 1);
  h.store.close();
});
for (const key of ['backup', 'dependency'])
  test(`${key} failure never receives a route switch`, async () => {
    const h = fixture();
    h.health[key] = false;
    const id = h.create();
    await h.advance(id, 20);
    assert.equal(h.writes, 0);
    assert.equal(h.store.incident(id).outcome, 'failed');
    h.store.close();
  });
test('unknown accepted start is inspected, not repeated', async () => {
  const h = fixture();
  h.health.running = false;
  h.health.crashStart = true;
  const id = h.create();
  await h.advance(id, 2);
  h.jump(31000);
  const resumed = new Orchestrator(h.store, h.runtime, () => h.now);
  await resumed.advance(id);
  assert.equal(h.starts, 1);
  assert.equal(h.store.incident(id).phase, 'Validate');
  h.store.close();
});
test('unknown accepted route is read back, not repeated', async () => {
  const h = fixture();
  h.health.crashRoute = true;
  const id = h.create();
  await h.advance(id, 5);
  h.jump(31000);
  const resumed = new Orchestrator(h.store, h.runtime, () => h.now);
  await resumed.advance(id);
  await resumed.advance(id);
  assert.equal(h.writes, 1);
  assert.equal(h.store.incident(id).outcome, 'recovered');
  h.store.close();
});
test('idempotency prevents duplicate operations and detects changed requests', () => {
  const h = fixture();
  const key = randomUUID();
  const id = h.create(key);
  assert.equal(h.create(key), id);
  assert.throws(() => h.create(), /operation/);
  assert.throws(
    () => h.worker.create(h.app.id, 'primary', 'worker', key, 1, 'single-vantage'),
    /Idempotency/,
  );
  h.store.close();
});
test('lease generations fence old actors and preserve absolute deadlines', async () => {
  const h = fixture();
  const id = h.create();
  const deadline = h.store.incident(id).deadlineAt;
  const generation = h.store.one(
    'SELECT generation FROM operation_leases WHERE applicationId=?',
    h.app.id,
  ).generation;
  h.jump(31000);
  const resumed = new Orchestrator(h.store, h.runtime, () => h.now);
  resumed.acquire(h.app.id);
  assert.throws(() => h.worker.fence(h.app.id, generation, 1), /stale/);
  assert.equal(h.store.incident(id).deadlineAt, deadline);
  h.jump(31000);
  await resumed.advance(id);
  assert.equal(h.store.incident(id).outcome, 'failed');
  assert.equal(h.writes, 0);
  h.store.close();
});
test('external route edits stop for reconciliation', async () => {
  const h = fixture();
  const id = h.create();
  await h.advance(id, 4);
  h.edit(h.records.map((r) => ({ ...r, content: '1.1.1.1' })));
  await h.advance(id);
  assert.equal(h.writes, 0);
  assert.equal(h.store.incident(id).outcome, 'reconciliation_required');
  h.store.close();
});
test('partial A/AAAA updates stay unknown and never invent an active backup', async () => {
  const h = fixture();
  const app = h.store.application(h.app.id);
  const backup = app.origins.find((o) => o.role === 'backup');
  backup.ipv6 = '2606:4700:4700::1001';
  h.store.run('UPDATE origins SET config=? WHERE id=?', JSON.stringify(backup), backup.id);
  app.routing.snapshot.push({
    id: 'aaaa',
    type: 'AAAA',
    name: app.publicHostname,
    content: '2606:4700:4700::1111',
    proxied: true,
    ttl: 1,
  });
  h.store.run(
    'UPDATE routing_configs SET config=? WHERE applicationId=?',
    JSON.stringify(app.routing),
    app.id,
  );
  h.edit(app.routing.snapshot);
  h.health.partial = true;
  const id = h.create();
  await h.advance(id);
  assert.equal(h.store.incident(id).outcome, 'reconciliation_required');
  assert.notEqual(h.store.application(app.id).activeOriginId, backup.id);
  h.store.close();
});
test('wrong public identity does not mark recovery complete', async () => {
  const h = fixture();
  h.health.publicIdentity = false;
  const id = h.create();
  await h.advance(id, 26);
  assert.equal(h.store.incident(id).outcome, 'reconciliation_required');
  assert.equal(h.store.application(h.app.id).activeOriginId, h.app.activeOriginId);
  h.store.close();
});
test('read-only dry run leaves all remote write counters at zero', async () => {
  const h = fixture();
  h.health.running = false;
  const plan = await h.worker.plan(h.app.id, 'backup');
  assert.equal(plan.startResource, true);
  assert.equal(h.starts, 0);
  assert.equal(h.writes, 0);
  h.store.close();
});
test('cancel before route retains it; cancel after intent requires reconciliation', async () => {
  const h = fixture();
  const first = h.create();
  await h.advance(first, 2);
  h.store.run('UPDATE incidents SET cancelRequested=1 WHERE id=?', first);
  await h.advance(first, 1);
  assert.equal(h.store.incident(first).outcome, 'cancelled');
  assert.equal(h.writes, 0);
  const second = h.create();
  await h.advance(second, 5);
  h.store.run('UPDATE incidents SET cancelRequested=1 WHERE id=?', second);
  await h.advance(second, 1);
  assert.equal(h.store.incident(second).outcome, 'reconciliation_required');
  h.store.close();
});
test('real SQLite backup/reopen retains configuration, intent and migrations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ptm-native-'));
  const h = fixture(join(dir, 'controller.sqlite'));
  const id = h.create();
  await h.advance(id, 2);
  const deadline = h.store.incident(id).deadlineAt;
  await h.store.db.backup(join(dir, 'backup.sqlite'));
  h.store.close();
  const restored = new Store(join(dir, 'backup.sqlite'), undefined, factory);
  assert.equal(restored.application(h.app.id).name, 'Native SQL test');
  assert.equal(restored.incident(id).deadlineAt, deadline);
  assert.equal(restored.steps(id).length, 1);
  assert.equal(restored.one('SELECT COUNT(*) AS n FROM schema_migrations').n, 2);
  restored.close();
});
test('provider HTTP mutations never retry and retain Retry-After without secret leakage', async () => {
  let calls = 0;
  const http = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    return new Response('{"token":"private"}', { status: 429, headers: { 'retry-after': '12' } });
  };
  await assert.rejects(
    () =>
      providerRequest(
        http,
        'https://developers.hostinger.com/api/vps/v1/virtual-machines/42/start',
        'private',
        'POST',
      ),
    (error) =>
      error instanceof ProviderHttpError &&
      error.retryAfterMs === 12000 &&
      !error.message.includes('private'),
  );
  assert.equal(calls, 1);
});
