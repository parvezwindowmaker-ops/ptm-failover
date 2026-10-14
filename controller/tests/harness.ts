import { randomUUID } from 'node:crypto';
import {
  Fault,
  applicationSchema,
  originSchema,
  policySchema,
  routingSchema,
  type Origin,
  type RecordSnapshot,
  type Probe,
  type Resource,
  type Application,
  type TrafficRouter,
} from '@ptm/contracts';
import { Store } from '../apps/api/src/db.js';
import { Orchestrator } from '@ptm/orchestrator';
import { routesEqual, targetRecords } from '@ptm/routing';

export function seed(store: Store) {
  const id = randomUUID();
  const a = applicationSchema.parse({
    name: 'Test API',
    publicHostname: `${id}.example.com`,
    desiredRelease: 'v1',
    demo: true,
  });
  store.run(
    'INSERT INTO applications(id,name,publicHostname,desiredRelease,demo,createdAt) VALUES(?,?,?,?,?,?)',
    id,
    a.name,
    a.publicHostname,
    a.desiredRelease,
    1,
    Date.now(),
  );
  for (const [n, role] of (['primary', 'backup'] as const).entries()) {
    const oid = randomUUID();
    const config = originSchema.parse({
      role,
      address: '127.0.0.1',
      tlsHostname: a.publicHostname,
      ipv4: `8.8.8.${n + 1}`,
      expectedIdentity: role,
      resourceId: oid,
      startOnFailure: role === 'backup',
    });
    store.run(
      'INSERT INTO origins(id,applicationId,role,config) VALUES(?,?,?,?)',
      oid,
      id,
      role,
      JSON.stringify(config),
    );
  }
  const os = store.origins(id);
  store.run(
    'UPDATE applications SET activeOriginId=?,automationEnabled=1,operationalState=? WHERE id=?',
    os.find((o) => o.role === 'primary')!.id,
    'HEALTHY_PRIMARY',
    id,
  );
  store.run(
    'INSERT INTO failover_policies VALUES(?,?)',
    id,
    JSON.stringify(
      policySchema.parse({
        intervalSeconds: 2,
        cooldownSeconds: 0,
        failbackHealthySeconds: 5,
        confirmation: 'single-vantage',
        bootDeadlineSeconds: 30,
        objectiveSeconds: 60,
      }),
    ),
  );
  const snapshot: RecordSnapshot[] = [
    { id: 'record-a', type: 'A', name: a.publicHostname, content: '8.8.8.1', proxied: true, ttl: 1 },
  ];
  store.run(
    'INSERT INTO routing_configs VALUES(?,?,?)',
    id,
    null,
    JSON.stringify({ ...routingSchema.parse({ type: 'demo' }), snapshot, revision: 1 }),
  );
  return store.application(id);
}
export function harness(path = ':memory:') {
  const store = new Store(path);
  const app = seed(store);
  let now = Date.now();
  let records = [...app.routing!.snapshot];
  let starts = 0;
  let writes = 0;
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
  const router: TrafficRouter = {
    async validateConfiguration() {
      return records;
    },
    async readRoute() {
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
      records = health.partial ? [{ ...plan[0] }, ...records.slice(1)] : plan;
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
        async validateCredentials() {},
        async listResources(): Promise<Resource[]> {
          return [];
        },
        async inspectResource(id: string): Promise<Resource> {
          return { id, name: id, power: health.running ? 'running' : 'stopped', addresses: [] };
        },
        async startResource() {
          starts++;
          health.running = true;
          if (health.crashStart) throw new Fault('PROVIDER_OUTCOME_UNKNOWN', 'Unknown', 502, true);
          return { requestId: 'test-start' };
        },
      };
    },
    router() {
      return router;
    },
    async probe(_a: Application, o: Origin, publicRoute = false): Promise<Probe> {
      const success =
        health[o.role] &&
        health.dependency &&
        (o.role === 'primary' || health.running) &&
        (!publicRoute || health.publicIdentity);
      return {
        at: now,
        success,
        status: success ? 200 : 503,
        latency: 3,
        reason: success
          ? null
          : !health.dependency
            ? 'SHARED_DEPENDENCY_FAILED'
            : publicRoute
              ? 'IDENTITY_MISMATCH'
              : 'UNREADY',
        identity: success ? o.expectedIdentity : null,
        release: 'v1',
      };
    },
  };
  const worker = new Orchestrator(store, runtime, () => now);
  function incident() {
    return worker.create(app.id, 'backup', 'worker', randomUUID(), 1, 'single-vantage');
  }
  async function advance(id: string, ticks = 10) {
    for (let t = 0; t < ticks; t++) {
      await worker.advance(id);
      now += 2500;
    }
  }
  return {
    store,
    app,
    worker,
    runtime,
    health,
    incident,
    advance,
    get now() {
      return now;
    },
    jump(ms: number) {
      now += ms;
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
    edit(next: RecordSnapshot[]) {
      records = next;
    },
  };
}
