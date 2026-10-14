import { createServer, type Server } from 'node:http';
import {
  Fault,
  type ServerProvider,
  type TrafficRouter,
  type Resource,
  type Application,
  type RecordSnapshot,
  type Origin,
} from '@ptm/contracts';
import { routesEqual, targetRecords } from '@ptm/routing';
import type { Store } from './db.js';

export class DemoProvider implements ServerProvider {
  constructor(private store: Store) {}
  capabilities() {
    return { inspect: true, start: true };
  }
  async validateCredentials() {}
  async listResources() {
    return this.store.all('SELECT id FROM demo_resources').map((r) => this.resource(r.id as string));
  }
  private resource(id: string): Resource {
    const r = this.store.one('SELECT * FROM demo_resources WHERE id=?', id);
    if (!r) throw new Fault('DEMO_RESOURCE_MISSING', 'Demo origin not found');
    return { id, name: id, power: r.running ? 'running' : 'stopped', addresses: [] };
  }
  async inspectResource(id: string) {
    return this.resource(id);
  }
  async startResource(id: string) {
    this.resource(id);
    this.store.run('UPDATE demo_resources SET running=1,starts=starts+1 WHERE id=?', id);
    return { requestId: `demo-${id}` };
  }
}
export class DemoRouter implements TrafficRouter {
  constructor(
    private store: Store,
    private app: Application,
  ) {}
  async validateConfiguration() {
    return this.readRoute();
  }
  async readRoute(): Promise<RecordSnapshot[]> {
    const r = this.store.one('SELECT records FROM demo_routes WHERE applicationId=?', this.app.id);
    if (!r) throw new Fault('DEMO_ROUTE_MISSING', 'Demo route not configured');
    return JSON.parse(r.records as string);
  }
  async planSwitch(target: Origin, approved: RecordSnapshot[]) {
    if (!routesEqual(await this.readRoute(), approved, true))
      throw new Fault('RECONCILIATION_REQUIRED', 'Demo routing changed outside the approved snapshot', 409);
    return targetRecords(target, approved);
  }
  async applySwitch(plan: RecordSnapshot[], beforeWrite: () => void) {
    beforeWrite();
    this.store.run(
      'UPDATE demo_routes SET records=?,writes=writes+1 WHERE applicationId=?',
      JSON.stringify(plan),
      this.app.id,
    );
  }
  async inspectConvergence(plan: RecordSnapshot[]) {
    return routesEqual(await this.readRoute(), plan);
  }
}
export async function startDemoOrigins(store: Store): Promise<Server[]> {
  const servers: Server[] = [];
  for (const port of [9091, 9092, 9093]) {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const id = new URL(req.url ?? '/', 'http://localhost').pathname.split('/')[2];
      let originId = id;
      if (port === 9093) {
        const app = store.one('SELECT applicationId FROM origins WHERE id=?', id);
        const route =
          app && store.one('SELECT records FROM demo_routes WHERE applicationId=?', app.applicationId);
        const target = route ? (JSON.parse(route.records as string) as RecordSnapshot[])[0]?.content : null;
        originId = app
          ? (store.origins(app.applicationId as string).find((o) => o.ipv4 === target)?.id ?? '')
          : '';
      }
      const r = store.one(
        'SELECT d.*,o.config,a.desiredRelease FROM demo_resources d JOIN origins o ON o.id=d.id JOIN applications a ON a.id=o.applicationId WHERE d.id=?',
        originId,
      );
      if (!r) {
        res.writeHead(404).end('{}');
        return;
      }
      const config = JSON.parse(r.config as string);
      if (port !== 9093 && config.port !== port) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(r.healthy && r.running && r.dependencies ? 200 : 503);
      res.end(
        JSON.stringify({
          status: r.healthy && r.running ? 'ready' : 'unready',
          serverId: r.identityOverride ?? config.expectedIdentity,
          release: r.desiredRelease,
          dependencies: { database: !!r.dependencies },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    servers.push(server);
  }
  return servers;
}
