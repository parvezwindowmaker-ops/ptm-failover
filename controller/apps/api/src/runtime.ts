import { Fault, type Application, type Origin } from '@ptm/contracts';
import { AwsProvider, GenericProvider, HostingerProvider } from '@ptm/providers';
import { CloudflareRouter } from '@ptm/routing';
import { DemoProvider, DemoRouter } from './demo.js';
import { probe } from './probe.js';
import type { Store } from './db.js';
import type { Vault } from './security.js';
import type { Runtime } from '@ptm/orchestrator';

export function createRuntime(store: Store, vault: Vault, demoEnabled: boolean): Runtime {
  function demoCheck(app: Application) {
    if (app.demo && !demoEnabled)
      throw new Fault('DEMO_DISABLED', 'This installation does not allow demo fixtures');
  }
  return {
    provider(app: Application, origin: Origin) {
      demoCheck(app);
      if (app.demo) return new DemoProvider(store);
      if (!origin.providerConnectionId) return new GenericProvider();
      const p = store.providers().find((p) => p.id === origin.providerConnectionId);
      if (!p) throw new Fault('PROVIDER_MISSING', 'Provider connection is missing');
      const secret = store.credentials(p.id, vault);
      if (p.type === 'hostinger') return new HostingerProvider(secret.token, p.config.resourceIds);
      if (p.type === 'aws') return new AwsProvider(secret, p.config.region ?? '', p.config.resourceIds);
      if (p.type === 'generic') return new GenericProvider();
      throw new Fault('INVALID_PROVIDER', 'A routing provider cannot manage a server');
    },
    router(app: Application) {
      demoCheck(app);
      if (!app.routing) throw new Fault('ROUTING_MISSING', 'Routing is not configured');
      if (app.demo && app.routing.type === 'demo') return new DemoRouter(store, app);
      if (app.demo || app.routing.type !== 'cloudflare')
        throw new Fault('DEMO_ISOLATION', 'Demo applications cannot use production routing');
      const p = store.providers().find((p) => p.id === app.routing!.providerConnectionId);
      if (p?.type !== 'cloudflare') throw new Fault('ROUTING_PROVIDER', 'Select a Cloudflare connection');
      return new CloudflareRouter(store.credentials(p.id, vault).token, app.publicHostname, app.routing);
    },
    probe(app, origin, publicRoute = false) {
      demoCheck(app);
      if (app.demo) {
        // Fixture addresses, ports and readiness paths are generated server-side, never supplied by users.
        const fixture = {
          ...origin,
          address: '127.0.0.1',
          protocol: 'http' as const,
          tlsHostname: 'demo.ptm.local',
          port: publicRoute ? 9093 : origin.role === 'primary' ? 9091 : 9092,
          readinessPath: `/ready/${origin.id}`,
          approvedPrivateCidrs: [],
        };
        return probe(fixture, app.desiredRelease, app.policy.timeoutSeconds * 1000, { demo: true });
      }
      if (origin.tlsHostname !== app.publicHostname && !origin.tlsHostname.endsWith('.' + app.publicHostname))
        throw new Fault('TLS_SCOPE', 'Origin Host/SNI must match the application hostname or a subdomain');
      return probe(
        origin,
        app.desiredRelease,
        app.policy.timeoutSeconds * 1000,
        publicRoute ? { publicHostname: app.publicHostname } : {},
      );
    },
  };
}
