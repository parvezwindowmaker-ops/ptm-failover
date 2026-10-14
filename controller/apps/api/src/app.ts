import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import swagger from '@fastify/swagger';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  applicationSchema,
  claimSchema,
  credentialsSchema,
  providerSchema,
  originSchema,
  policySchema,
  routingSchema,
  sshUploadSchema,
  Fault,
  type Origin,
  type Application,
  type RoutingConfig,
  type Overview,
  type SshView,
} from '@ptm/contracts';
import { Orchestrator } from '@ptm/orchestrator';
import { AwsProvider, GenericProvider, HostingerProvider, providerRequest } from '@ptm/providers';
import { CloudflareRouter, routesEqual, targetRecords } from '@ptm/routing';
import { Store } from './db.js';
import { Vault, equalSecret, hashToken, randomToken } from './security.js';
import { createRuntime } from './runtime.js';
import { validateWebhook } from './notifications.js';
import { validateSshKey, testSshConnection, type SshSecret } from './ssh.js';

type Options = {
  store: Store;
  vault: Vault;
  bootstrapToken: string;
  demo: boolean;
  baseUrl: string;
  logger?: boolean;
  serveWeb?: boolean;
};
export async function buildApp(options: Options) {
  const { store, vault } = options;
  const base = new URL(options.baseUrl);
  const streams = new Set<import('node:http').ServerResponse>();
  const api = Fastify({
    logger: options.logger
      ? {
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.body',
            'res.headers["set-cookie"]',
          ],
        }
      : false,
    bodyLimit: 65536,
    trustProxy: false,
  });
  await api.register(cookie);
  await api.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],
      },
    },
  });
  await api.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await api.register(swagger, {
    openapi: {
      info: { title: 'PTM Failover', version: '0.1.0' },
      servers: [{ url: options.baseUrl }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'ptm_session' },
          csrf: { type: 'apiKey', in: 'header', name: 'x-csrf-token' },
        },
      },
    },
  });
  api.addHook('onRoute', (route) => {
    if (route.url.startsWith('/api/v1'))
      route.schema = {
        ...route.schema,
        tags: [route.url.split('/')[3]],
        security:
          route.url.includes('/auth/') || route.url.includes('/setup/') || route.url.includes('/health/')
            ? []
            : [{ session: [], csrf: [] }],
      };
  });
  const runtime = createRuntime(store, vault, options.demo);
  const worker = new Orchestrator(store, runtime);
  const canary = store.get<string | null>('keyCheck', null);
  if (canary) vault.decrypt(canary, 'installation');
  else store.set('keyCheck', vault.encrypt({ valid: true }, 'installation'));
  for (const p of store.providers()) store.credentials(p.id, vault);
  for (const connection of store.all('SELECT originId,encryptedSecret FROM ssh_connections'))
    vault.decrypt(connection.encryptedSecret as string, `ssh:${connection.originId}`);
  if (options.bootstrapToken.length < 32)
    throw new Error('Bootstrap token must contain at least 32 characters');
  const actor = (req: FastifyRequest) => (req as FastifyRequest & { owner: string }).owner;
  const safePaths = [
    '/api/v1/setup/claim',
    '/api/v1/auth/login',
    '/api/v1/auth/session',
    '/api/v1/health/live',
    '/api/v1/health/ready',
  ];
  api.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    const path = req.url.split('?')[0];
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== base.origin)
      throw new Fault('ORIGIN_REQUIRED', 'Mutation Origin must match APP_BASE_URL', 403);
    if (safePaths.includes(path)) return;
    const session =
      req.cookies.ptm_session &&
      store.one(
        'SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.userId WHERE tokenHash=?',
        hashToken(req.cookies.ptm_session),
      );
    if (!session || Number(session.expiresAt) <= Date.now()) {
      reply.clearCookie('ptm_session', { path: '/' });
      throw new Fault('UNAUTHORIZED', 'Sign in to continue', 401);
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      (!req.headers['x-csrf-token'] ||
        !equalSecret(String(req.headers['x-csrf-token']), session.csrf as string))
    )
      throw new Fault('CSRF_FAILED', 'Session CSRF token is required', 403);
    (req as FastifyRequest & { owner: string }).owner = session.username as string;
    store.run('UPDATE sessions SET lastSeen=? WHERE tokenHash=?', Date.now(), session.tokenHash);
  });
  api.setErrorHandler((error, req, reply) => {
    const fault = error instanceof Fault ? error : null;
    const invalid = error instanceof z.ZodError;
    const status = fault?.status ?? (invalid ? 400 : ((error as { statusCode?: number }).statusCode ?? 500));
    if (status >= 500)
      api.log.error({ correlationId: req.id, code: fault?.code ?? 'INTERNAL_ERROR' }, 'Request failed');
    void reply.code(status).send({
      code:
        fault?.code ?? (invalid ? 'VALIDATION_ERROR' : status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR'),
      message:
        fault?.message ??
        (invalid
          ? 'Check the form fields'
          : status === 429
            ? 'Too many requests. Try again later.'
            : 'Request failed; sensitive details withheld'),
      fieldErrors: invalid ? z.flattenError(error).fieldErrors : undefined,
      correlationId: req.id,
      retryable: fault?.retryable ?? status >= 500,
    });
  });
  api.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });
  const authSchema = { body: z.toJSONSchema(credentialsSchema, { target: 'draft-7' }) };
  function session(
    userId: string,
    reply: { setCookie: (name: string, value: string, opts: object) => unknown },
  ) {
    const token = randomToken();
    const csrf = randomToken();
    store.run(
      'INSERT INTO sessions VALUES(?,?,?,?,?)',
      hashToken(token),
      userId,
      csrf,
      Date.now() + 43200000,
      Date.now(),
    );
    reply.setCookie('ptm_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: base.protocol === 'https:',
      maxAge: 43200,
    });
    return csrf;
  }
  api.post(
    '/api/v1/setup/claim',
    {
      schema: { body: z.toJSONSchema(claimSchema, { target: 'draft-7' }) },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const input = claimSchema.parse(req.body);
      if (!equalSecret(input.bootstrapToken, options.bootstrapToken))
        throw new Fault('BOOTSTRAP_INVALID', 'Invalid bootstrap credential', 403);
      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      const id = randomUUID();
      store.tx(() => {
        if (store.one('SELECT id FROM users LIMIT 1') || store.get('claimed', false))
          throw new Fault('ALREADY_CLAIMED', 'Installation was already claimed', 409);
        store.run('INSERT INTO users VALUES(?,?,?,?)', id, input.username, passwordHash, Date.now());
        store.set('claimed', true);
        store.audit(input.username, 'installation.claimed', id);
      });
      return { username: input.username, csrfToken: session(id, reply) };
    },
  );
  api.post(
    '/api/v1/auth/login',
    { schema: authSchema, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const input = credentialsSchema.parse(req.body);
      const user = store.one('SELECT * FROM users WHERE username=?', input.username);
      if (!user || !(await argon2.verify(user.passwordHash as string, input.password)))
        throw new Fault('LOGIN_FAILED', 'Username or password is incorrect', 401);
      store.audit(input.username, 'auth.login', user.id as string);
      return { username: input.username, csrfToken: session(user.id as string, reply) };
    },
  );
  api.get('/api/v1/auth/session', async (req) => {
    const claimed = !!store.one('SELECT id FROM users LIMIT 1');
    const s = req.cookies.ptm_session
      ? store.one(
          'SELECT s.*,u.username FROM sessions s JOIN users u ON s.userId=u.id WHERE tokenHash=? AND expiresAt>?',
          hashToken(req.cookies.ptm_session),
          Date.now(),
        )
      : undefined;
    return { claimed, username: s?.username ?? null, csrfToken: s?.csrf ?? null };
  });
  api.post('/api/v1/auth/logout', async (req, reply) => {
    store.run('DELETE FROM sessions WHERE tokenHash=?', hashToken(req.cookies.ptm_session ?? ''));
    reply.clearCookie('ptm_session', { path: '/' });
    return { ok: true };
  });
  const status = () => ({
    demo: options.demo,
    heartbeat: worker.heartbeat,
    healthy: worker.heartbeat !== null && Date.now() - worker.heartbeat < 60000,
    replica: 'single',
    location: store.get('location', 'Not declared'),
    version: '0.1.0',
  });
  api.get('/api/v1/controller/status', async () => status());
  api.get('/api/v1/health/live', async () => ({ status: 'live' }));
  api.get('/api/v1/health/ready', async (_, reply) => {
    const healthy = status().healthy;
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'worker unavailable' });
  });
  api.get('/api/v1/overview', async (): Promise<Overview> => {
    const apps = store.applications();
    const incidents = store.incidents(8);
    const last = store.one(
      'SELECT startedAt,completedAt FROM incidents WHERE outcome=? ORDER BY completedAt DESC LIMIT 1',
      'recovered',
    );
    return {
      applications: apps,
      monitored: apps.filter((a) => a.origins.length === 2).length,
      unhealthy: apps.flatMap((a) => a.origins).filter((o) => o.observation && !o.observation.success).length,
      openIncidents: Number(store.one('SELECT COUNT(*) AS n FROM incidents WHERE outcome IS NULL')?.n ?? 0),
      lastRecoveryMs: last ? Number(last.completedAt) - Number(last.startedAt) : null,
      incidents,
    };
  });
  api.get('/api/v1/providers', async () => store.providers());
  const validateProviderSecret = (type: string, secret: Record<string, string>) => {
    const required =
      type === 'aws' ? ['accessKeyId', 'secretAccessKey'] : type === 'generic' ? [] : ['token'];
    if (required.some((key) => !secret[key]?.trim()))
      throw new Fault('CREDENTIALS_REQUIRED', 'Enter new non-empty credentials for this provider', 400);
  };
  api.post(
    '/api/v1/providers',
    { schema: { body: z.toJSONSchema(providerSchema, { target: 'draft-7' }) } },
    async (req) => {
      const p = providerSchema.parse(req.body);
      validateProviderSecret(p.type, p.secret);
      if (options.demo && p.type !== 'generic')
        throw new Fault('DEMO_ISOLATION', 'Demo installation accepts no real provider credentials');
      const id = randomUUID();
      store.run(
        'INSERT INTO provider_connections(id,type,label,encryptedSecret,config) VALUES(?,?,?,?,?)',
        id,
        p.type,
        p.label,
        vault.encrypt(p.secret, id),
        JSON.stringify(p.config),
      );
      store.audit(actor(req), 'provider.created', id, { type: p.type, label: p.label });
      return store.providers().find((p) => p.id === id);
    },
  );
  const idOf = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  api.patch('/api/v1/providers/:id', async (req) => {
    const id = idOf(req);
    const p = store.providers().find((p) => p.id === id);
    if (!p) throw new Fault('NOT_FOUND', 'Provider not found', 404);
    if (
      store.one(
        'SELECT i.id FROM incidents i JOIN origins o ON o.applicationId=i.applicationId WHERE i.outcome IS NULL AND o.providerConnectionId=? UNION SELECT i.id FROM incidents i JOIN routing_configs r ON r.applicationId=i.applicationId WHERE i.outcome IS NULL AND r.providerConnectionId=?',
        id,
        id,
      )
    )
      throw new Fault('OPERATION_CONFLICT', 'Provider is in use by an active incident', 409);
    const input = providerSchema.partial().parse(req.body);
    if (input.secret) validateProviderSecret(p.type, input.secret);
    if (input.type && input.type !== p.type)
      throw new Fault('TYPE_IMMUTABLE', 'Create a new connection to change provider type');
    store.run(
      'UPDATE provider_connections SET label=?,config=?,encryptedSecret=?,lastValidated=NULL,validationState=? WHERE id=?',
      input.label ?? p.label,
      JSON.stringify(input.config ?? p.config),
      input.secret
        ? vault.encrypt(input.secret, id)
        : store.one('SELECT encryptedSecret FROM provider_connections WHERE id=?', id)!.encryptedSecret,
      'Unknown',
      id,
    );
    store.audit(actor(req), 'provider.updated', id, { secretReplaced: !!input.secret });
    return store.providers().find((p) => p.id === id);
  });
  api.delete('/api/v1/providers/:id', async (req) => {
    const id = idOf(req);
    if (
      store.one('SELECT id FROM origins WHERE providerConnectionId=?', id) ||
      store.one('SELECT applicationId FROM routing_configs WHERE providerConnectionId=?', id)
    )
      throw new Fault(
        'PROVIDER_IN_USE',
        'Remove origin and routing references before deleting this connection',
        409,
      );
    store.run('DELETE FROM provider_connections WHERE id=?', id);
    store.audit(actor(req), 'provider.deleted', id);
    return { ok: true };
  });
  function provider(id: string) {
    const p = store.providers().find((p) => p.id === id);
    if (!p) throw new Fault('NOT_FOUND', 'Provider not found', 404);
    const s = store.credentials(id, vault);
    return p.type === 'aws'
      ? new AwsProvider(s, p.config.region ?? '', p.config.resourceIds)
      : p.type === 'hostinger'
        ? new HostingerProvider(s.token, p.config.resourceIds)
        : new GenericProvider();
  }
  api.post('/api/v1/providers/:id/test', async (req) => {
    const id = idOf(req);
    const p = store.providers().find((p) => p.id === id);
    if (!p) throw new Fault('NOT_FOUND', 'Provider not found', 404);
    try {
      if (p.type === 'cloudflare') {
        const result = await providerRequest(
          fetch,
          'https://api.cloudflare.com/client/v4/user/tokens/verify',
          store.credentials(id, vault).token,
        );
        const verified = z
          .object({ success: z.literal(true), result: z.object({ status: z.literal('active') }) })
          .safeParse(result);
        if (!verified.success)
          throw new Fault('CREDENTIAL_VALIDATION_FAILED', 'Cloudflare token is not active');
      } else await provider(id).validateCredentials();
      store.run(
        'UPDATE provider_connections SET lastValidated=?,validationState=? WHERE id=?',
        Date.now(),
        'Valid',
        id,
      );
      return { valid: true, scope: p.config.resourceIds, readOnly: true };
    } catch {
      store.run(
        'UPDATE provider_connections SET lastValidated=?,validationState=? WHERE id=?',
        Date.now(),
        'Failed',
        id,
      );
      throw new Fault(
        'CREDENTIAL_VALIDATION_FAILED',
        'Read-only provider validation failed. Check credentials and scope.',
        400,
      );
    }
  });
  api.get('/api/v1/providers/:id/resources', async (req) => provider(idOf(req)).listResources());
  api.get('/api/v1/applications', async () => store.applications());
  api.post(
    '/api/v1/applications',
    { schema: { body: z.toJSONSchema(applicationSchema, { target: 'draft-7' }) } },
    async (req) => {
      const a = applicationSchema.parse(req.body);
      if (a.demo !== options.demo)
        throw new Fault(
          'DEMO_ISOLATION',
          options.demo
            ? 'Only demo applications are allowed in this installation'
            : 'Demo fixtures require DEMO_MODE=true',
        );
      const id = randomUUID();
      store.tx(() => {
        if (store.one('SELECT id FROM applications WHERE publicHostname=?', a.publicHostname))
          throw new Fault('HOSTNAME_EXISTS', 'An application already owns this public hostname', 409);
        store.run(
          'INSERT INTO applications(id,name,publicHostname,desiredRelease,demo,createdAt) VALUES(?,?,?,?,?,?)',
          id,
          a.name,
          a.publicHostname,
          a.desiredRelease,
          Number(a.demo),
          Date.now(),
        );
        store.run(
          'INSERT INTO failover_policies VALUES(?,?)',
          id,
          JSON.stringify(
            policySchema.parse(
              a.demo
                ? {
                    intervalSeconds: 2,
                    objectiveSeconds: 300,
                    bootDeadlineSeconds: 60,
                    cooldownSeconds: 0,
                    failbackHealthySeconds: 5,
                  }
                : {},
            ),
          ),
        );
        if (a.demo) {
          const ips = ['10.77.0.10', '10.77.0.20'];
          const origins: Origin[] = [];
          for (const [idx, role] of (['primary', 'backup'] as const).entries()) {
            const oid = randomUUID();
            const config = originSchema.parse({
              role,
              address: '127.0.0.1',
              tlsHostname: a.publicHostname,
              protocol: 'http',
              port: 9091 + idx,
              readinessPath: `/ready/${oid}`,
              expectedIdentity: `${role}-${id.slice(0, 8)}`,
              ipv4: ips[idx],
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
            store.run('INSERT INTO demo_resources(id) VALUES(?)', oid);
            origins.push({
              ...config,
              id: oid,
              applicationId: id,
              observation: null,
              power: 'unknown',
              healthySince: null,
            });
          }
          const routing: RoutingConfig = {
            ...routingSchema.parse({ type: 'demo' }),
            revision: 1,
            snapshot: [
              { id: `demo-${id}`, type: 'A', name: a.publicHostname, content: ips[0], proxied: true, ttl: 1 },
            ],
          };
          store.run('INSERT INTO routing_configs VALUES(?,?,?)', id, null, JSON.stringify(routing));
          store.run(
            'INSERT INTO demo_routes(applicationId,records) VALUES(?,?)',
            id,
            JSON.stringify(routing.snapshot),
          );
          store.run('UPDATE applications SET activeOriginId=? WHERE id=?', origins[0].id, id);
        }
        store.audit(actor(req), 'application.created', id, a);
      });
      return store.application(id);
    },
  );
  api.get('/api/v1/applications/:id', async (req) => store.application(idOf(req)));
  const revisionSchema = z.object({ revision: z.number().int().min(1) });
  api.patch('/api/v1/applications/:id', async (req) => {
    const id = idOf(req);
    const input = applicationSchema
      .omit({ demo: true })
      .partial()
      .extend(revisionSchema.shape)
      .parse(req.body);
    store.tx(() => {
      const a = store.assertEditable(id, input.revision);
      if (input.publicHostname && input.publicHostname !== a.publicHostname && a.routing)
        throw new Fault(
          'TOPOLOGY_REVIEW_REQUIRED',
          'Configure a new application for a different managed hostname',
        );
      store.run(
        'UPDATE applications SET name=?,publicHostname=?,desiredRelease=?,configurationRevision=configurationRevision+1 WHERE id=?',
        input.name ?? a.name,
        input.publicHostname ?? a.publicHostname,
        input.desiredRelease ?? a.desiredRelease,
        id,
      );
      store.audit(actor(req), 'application.updated', id, {
        name: input.name,
        desiredRelease: input.desiredRelease,
      });
    });
    return store.application(id);
  });
  api.put('/api/v1/applications/:id/origins', async (req) => {
    const id = idOf(req);
    const input = revisionSchema.extend({ origins: z.array(originSchema).length(2) }).parse(req.body);
    const app = store.assertEditable(id, input.revision);
    if (app.demo || new Set(input.origins.map((o) => o.role)).size !== 2)
      throw new Fault('ORIGIN_CONFIGURATION', 'Use one primary and one backup; demo topology is fixed');
    for (const o of input.origins) {
      if (o.tlsHostname !== app.publicHostname && !o.tlsHostname.endsWith('.' + app.publicHostname))
        throw new Fault('TLS_SCOPE', 'Host/SNI must match the application scope');
      const p = store.providers().find((p) => p.id === o.providerConnectionId);
      if (o.providerConnectionId && (!p || !['aws', 'hostinger', 'generic'].includes(p.type)))
        throw new Fault('ORIGIN_PROVIDER', 'Select a valid server provider');
      if (
        o.startOnFailure &&
        (!p || !['aws', 'hostinger'].includes(p.type) || !p.config.resourceIds.includes(o.resourceId))
      )
        throw new Fault(
          'RESOURCE_SCOPE',
          'Start-on-failure requires a power-capable provider with the resource explicitly allowed',
        );
    }
    store.tx(() => {
      store.assertEditable(id, input.revision);
      for (const o of input.origins) {
        const existing = app.origins.find((x) => x.role === o.role);
        if (existing)
          store.run(
            "UPDATE ssh_connections SET lastTested=NULL,validationState='Unknown' WHERE originId=?",
            existing.id,
          );
        if (existing)
          store.run(
            'UPDATE origins SET config=?,providerConnectionId=?,observation=NULL,healthySince=NULL WHERE id=?',
            JSON.stringify(o),
            o.providerConnectionId,
            existing.id,
          );
        else
          store.run(
            'INSERT INTO origins(id,applicationId,role,providerConnectionId,config) VALUES(?,?,?,?,?)',
            randomUUID(),
            id,
            o.role,
            o.providerConnectionId,
            JSON.stringify(o),
          );
      }
      if (!app.activeOriginId)
        store.run(
          'UPDATE applications SET activeOriginId=(SELECT id FROM origins WHERE applicationId=? AND role=?) WHERE id=?',
          id,
          'primary',
          id,
        );
      store.run(
        'UPDATE applications SET configurationRevision=configurationRevision+1,automationEnabled=0 WHERE id=?',
        id,
      );
      store.audit(actor(req), 'origins.updated', id);
    });
    return store.application(id);
  });
  const sshOrigin = (req: FastifyRequest) => {
    const id = idOf(req);
    const row = store.one('SELECT applicationId FROM origins WHERE id=?', id);
    if (!row) throw new Fault('NOT_FOUND', 'Origin not found', 404);
    const app = store.application(row.applicationId as string);
    return { app, origin: app.origins.find((o) => o.id === id)! };
  };
  const sshView = (originId: string): SshView | null => {
    const row = store.one(
      'SELECT config,passphraseConfigured,lastTested,validationState FROM ssh_connections WHERE originId=?',
      originId,
    );
    if (!row) return null;
    return {
      ...JSON.parse(row.config as string),
      configured: true,
      keyConfigured: true,
      passphraseConfigured: !!row.passphraseConfigured,
      lastTested: row.lastTested as number | null,
      validationState: row.validationState as SshView['validationState'],
    };
  };
  api.get('/api/v1/origins/:id/ssh', async (req) => sshView(sshOrigin(req).origin.id));
  api.put(
    '/api/v1/origins/:id/ssh',
    { schema: { body: z.toJSONSchema(sshUploadSchema, { target: 'draft-7' }) } },
    async (req) => {
      const { app, origin } = sshOrigin(req);
      if (app.demo || options.demo)
        throw new Fault('DEMO_ISOLATION', 'Real SSH credentials are disabled in demo mode', 400);
      const input = sshUploadSchema.parse(req.body);
      store.assertEditable(app.id, input.revision);
      const existing = store.one('SELECT encryptedSecret FROM ssh_connections WHERE originId=?', origin.id);
      if (!input.privateKey && !existing)
        throw new Fault('SSH_KEY_REQUIRED', 'Upload a private key to configure SSH', 400);
      if (!input.privateKey && input.passphrase !== undefined)
        throw new Fault('SSH_KEY_REQUIRED', 'Replace the private key together with its passphrase', 400);
      const secret: SshSecret = input.privateKey
        ? { privateKey: input.privateKey, ...(input.passphrase ? { passphrase: input.passphrase } : {}) }
        : vault.decrypt<SshSecret>(existing!.encryptedSecret as string, `ssh:${origin.id}`);
      validateSshKey(secret);
      const config = { username: input.username, port: input.port, hostFingerprint: input.hostFingerprint };
      store.tx(() => {
        store.assertEditable(app.id, input.revision);
        store.run(
          "INSERT INTO ssh_connections(originId,config,encryptedSecret,passphraseConfigured) VALUES(?,?,?,?) ON CONFLICT(originId) DO UPDATE SET config=excluded.config,encryptedSecret=excluded.encryptedSecret,passphraseConfigured=excluded.passphraseConfigured,lastTested=NULL,validationState='Unknown'",
          origin.id,
          JSON.stringify(config),
          vault.encrypt(secret, `ssh:${origin.id}`),
          Number(!!secret.passphrase),
        );
        store.run('UPDATE applications SET configurationRevision=configurationRevision+1 WHERE id=?', app.id);
        store.audit(actor(req), existing ? 'ssh.updated' : 'ssh.configured', origin.id, {
          username: config.username,
          port: config.port,
          keyReplaced: !!input.privateKey,
        });
      });
      return sshView(origin.id);
    },
  );
  api.delete('/api/v1/origins/:id/ssh', async (req) => {
    const { app, origin } = sshOrigin(req);
    const input = revisionSchema.parse(req.body);
    store.tx(() => {
      store.assertEditable(app.id, input.revision);
      store.run('DELETE FROM ssh_connections WHERE originId=?', origin.id);
      store.run('UPDATE applications SET configurationRevision=configurationRevision+1 WHERE id=?', app.id);
      store.audit(actor(req), 'ssh.removed', origin.id);
    });
    return { removed: true };
  });
  const sshTests = new Set<string>();
  api.post(
    '/api/v1/origins/:id/ssh/test',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const { app, origin } = sshOrigin(req);
      if (app.demo || options.demo)
        throw new Fault('DEMO_ISOLATION', 'Outbound SSH is disabled in demo mode', 400);
      const row = store.one('SELECT config,encryptedSecret FROM ssh_connections WHERE originId=?', origin.id);
      if (!row) throw new Fault('SSH_NOT_CONFIGURED', 'Configure SSH credentials first', 400);
      if (sshTests.has(origin.id) || sshTests.size >= 3)
        throw new Fault('SSH_TEST_BUSY', 'An SSH test is already running; try again shortly', 409, true);
      sshTests.add(origin.id);
      let valid = false;
      try {
        const secret = vault.decrypt<SshSecret>(row.encryptedSecret as string, `ssh:${origin.id}`);
        const result = await testSshConnection(origin, JSON.parse(row.config as string), secret);
        valid = true;
        if (store.application(app.id).configurationRevision !== app.configurationRevision)
          throw new Fault(
            'CONFIGURATION_CHANGED',
            'Server configuration changed during the test; test the current settings',
            409,
          );
        return { ...result, readOnly: true };
      } finally {
        sshTests.delete(origin.id);
        store.tx(() => {
          if (store.application(app.id).configurationRevision === app.configurationRevision) {
            store.run(
              'UPDATE ssh_connections SET lastTested=?,validationState=? WHERE originId=? AND config=? AND encryptedSecret=?',
              Date.now(),
              valid ? 'Valid' : 'Failed',
              origin.id,
              row.config,
              row.encryptedSecret,
            );
            store.audit(actor(req), valid ? 'ssh.test_passed' : 'ssh.test_failed', origin.id, {
              readOnly: true,
            });
          }
        });
      }
    },
  );
  api.put('/api/v1/applications/:id/routing', async (req) => {
    const id = idOf(req);
    const input = revisionSchema.extend({ routing: routingSchema }).parse(req.body);
    const app = store.assertEditable(id, input.revision);
    if (app.demo || input.routing.type !== 'cloudflare')
      throw new Fault('DEMO_ISOLATION', 'Production applications require Cloudflare routing');
    const p = store.providers().find((p) => p.id === input.routing.providerConnectionId);
    if (p?.type !== 'cloudflare') throw new Fault('ROUTING_PROVIDER', 'Select a Cloudflare connection');
    const draft = { ...input.routing, revision: (app.routing?.revision ?? 0) + 1, snapshot: [] };
    const router = new CloudflareRouter(store.credentials(p.id, vault).token, app.publicHostname, draft);
    const snapshot = await router.validateConfiguration();
    for (const o of app.origins) await router.planSwitch(o, snapshot);
    const active = app.origins.find((o) => o.id === app.activeOriginId);
    if (!active || !routesEqual(snapshot, targetRecords(active, snapshot)))
      throw new Fault(
        'ACTIVE_ROUTE_MISMATCH',
        'Existing records must point to the declared active origin before approval',
        409,
      );
    store.tx(() => {
      store.assertEditable(id, input.revision);
      store.run(
        'INSERT INTO routing_configs VALUES(?,?,?) ON CONFLICT(applicationId) DO UPDATE SET providerConnectionId=excluded.providerConnectionId,config=excluded.config',
        id,
        p.id,
        JSON.stringify({ ...draft, snapshot }),
      );
      store.run(
        'UPDATE applications SET configurationRevision=configurationRevision+1,automationEnabled=0 WHERE id=?',
        id,
      );
      store.audit(actor(req), 'routing.approved', id, { snapshot });
    });
    return store.application(id);
  });
  api.put('/api/v1/applications/:id/policy', async (req) => {
    const id = idOf(req);
    const input = revisionSchema
      .extend({ policy: policySchema, declarations: z.array(z.string().max(80)).max(8).optional() })
      .parse(req.body);
    store.tx(() => {
      store.assertEditable(id, input.revision);
      store.run(
        'UPDATE failover_policies SET config=? WHERE applicationId=?',
        JSON.stringify(input.policy),
        id,
      );
      store.run('UPDATE applications SET configurationRevision=configurationRevision+1 WHERE id=?', id);
      if (input.declarations) store.set(`declarations:${id}`, input.declarations);
      store.audit(actor(req), 'policy.updated', id, {
        policy: input.policy,
        declarations: input.declarations,
      });
    });
    return store.application(id);
  });
  api.post('/api/v1/applications/:id/check', async (req) => {
    const a = store.application(idOf(req));
    await worker.check(a);
    return store.application(a.id);
  });
  async function preflight(a: Application) {
    const checks: { label: string; ok: boolean; source: string }[] = [];
    for (const o of a.origins) {
      const p = await runtime.probe(a, o);
      checks.push({
        label: `${o.role} readiness and identity`,
        ok: p.success && !!o.expectedIdentity,
        source: p.reason ?? 'Direct read-only probe',
      });
    }
    let routingOk = false;
    try {
      routingOk = !!a.routing && routesEqual(await runtime.router(a).readRoute(), a.routing.snapshot, true);
    } catch {
      /* Sanitized checklist result */
    }
    checks.push({ label: 'Approved routing snapshot', ok: routingOk, source: 'Read-only API validation' });
    const declarations = store.get<string[]>(`declarations:${a.id}`, []);
    const requiredDeclarations = [
      'Durable database',
      'Compatible sessions / authentication',
      'Durable uploads',
      'TLS configured on both origins',
      'Image / release parity',
      'Backup capacity',
    ];
    checks.push({
      label: 'Durable database, sessions, uploads, TLS, release parity and capacity',
      ok: requiredDeclarations.every((declaration) => declarations.includes(declaration)),
      source: 'Operator declaration; not an infrastructure validation',
    });
    const active = a.origins.find((o) => o.id === a.activeOriginId);
    const publicProbe = active ? await runtime.probe(a, active, true) : null;
    checks.push({
      label: 'Public route corresponds to the declared active origin',
      ok: a.operationalState !== 'RECONCILIATION_REQUIRED' && !!publicProbe?.success,
      source: publicProbe?.reason ?? 'Public readiness identity and release verified from this controller',
    });
    return {
      ok: a.origins.length === 2 && checks.every((c) => c.ok),
      checks,
      scope: 'Single controller vantage; does not prove provider-wide health or global route convergence',
    };
  }
  api.post('/api/v1/applications/:id/preflight', async (req) => preflight(store.application(idOf(req))));
  api.post('/api/v1/applications/:id/dry-run', async (req) => {
    const { direction } = z
      .object({ direction: z.enum(['failover', 'failback']).default('failover') })
      .parse(req.body ?? {});
    return worker.plan(idOf(req), direction === 'failback' ? 'primary' : 'backup');
  });
  for (const direction of ['failover', 'failback'] as const)
    api.post(`/api/v1/applications/:id/${direction}`, async (req, reply) => {
      const id = idOf(req);
      const input = revisionSchema.extend({ planHash: z.string().length(64) }).parse(req.body);
      const key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
      const role = direction === 'failover' ? 'backup' : 'primary';
      const prior = store.one('SELECT operationId FROM idempotency_keys WHERE key=?', key);
      const plan = prior ? { planHash: input.planHash } : await worker.plan(id, role);
      const operationId = worker.create(
        id,
        role,
        actor(req),
        key,
        input.revision,
        'manual',
        input.planHash,
        plan.planHash,
      );
      return reply.code(202).send({ operationId });
    });
  api.post('/api/v1/applications/:id/automation', async (req) => {
    const id = idOf(req);
    const input = revisionSchema.extend({ enabled: z.boolean() }).parse(req.body);
    const a = store.assertEditable(id, input.revision);
    if (input.enabled && !(await preflight(a)).ok)
      throw new Fault('PREFLIGHT_FAILED', 'Resolve failed preflight checks before enabling automation');
    store.tx(() => {
      store.assertEditable(id, input.revision);
      store.run(
        'UPDATE applications SET automationEnabled=?,operationalState=?,configurationRevision=configurationRevision+1 WHERE id=?',
        Number(input.enabled),
        input.enabled
          ? a.activeOriginId === a.origins.find((o) => o.role === 'backup')?.id
            ? 'ACTIVE_BACKUP'
            : 'HEALTHY_PRIMARY'
          : 'PAUSED',
        id,
      );
      store.audit(actor(req), input.enabled ? 'automation.enabled' : 'automation.paused', id, {
        confirmation: a.policy.confirmation,
      });
    });
    return store.application(id);
  });
  api.get('/api/v1/applications/:id/routing/observed', async (req) => {
    const a = store.application(idOf(req));
    const records = await runtime.router(a).readRoute();
    return {
      records,
      routeHash: hashToken(JSON.stringify(records)),
      candidates: a.origins
        .filter((o) => {
          try {
            return records.every((r) => r.content === (r.type === 'A' ? o.ipv4 : o.ipv6));
          } catch {
            return false;
          }
        })
        .map((o) => ({ id: o.id, role: o.role })),
    };
  });
  api.post('/api/v1/applications/:id/reconcile', async (req) => {
    const id = idOf(req);
    const input = revisionSchema
      .extend({ originId: z.string().uuid(), routeHash: z.string().length(64) })
      .parse(req.body);
    const a = store.assertEditable(id, input.revision);
    const target = a.origins.find((o) => o.id === input.originId);
    if (!target || !target.expectedIdentity || !a.routing)
      throw new Fault(
        'IDENTITY_REQUIRED',
        'Reconciliation requires an identified origin and routing configuration',
      );
    const records = await runtime.router(a).readRoute();
    if (
      hashToken(JSON.stringify(records)) !== input.routeHash ||
      !records.every((r) => r.content === (r.type === 'A' ? target.ipv4 : target.ipv6))
    )
      throw new Fault('ROUTE_CONFLICT', 'Route is mixed, unknown or changed since review', 409);
    const direct = await runtime.probe(a, target);
    const publicProbe = await runtime.probe(a, target, true);
    if (!direct.success || !publicProbe.success)
      throw new Fault('VERIFICATION_FAILED', 'Direct and public identity readiness must both pass');
    store.tx(() => {
      store.assertEditable(id, input.revision);
      store.run(
        'UPDATE routing_configs SET config=? WHERE applicationId=?',
        JSON.stringify({ ...a.routing, snapshot: records, revision: a.routing!.revision + 1 }),
        id,
      );
      store.run(
        'UPDATE applications SET activeOriginId=?,operationalState=?,automationEnabled=0,configurationRevision=configurationRevision+1 WHERE id=?',
        target.id,
        'PAUSED',
        id,
      );
      store.audit(actor(req), 'routing.reconciled', id, {
        originId: target.id,
        records,
        scope: 'One controller vantage',
      });
    });
    return store.application(id);
  });
  api.get('/api/v1/applications/:id/probes', async (req) => {
    const id = idOf(req);
    store.application(id);
    const q = z.object({ hours: z.coerce.number().min(1).max(168).default(1) }).parse(req.query);
    return store
      .all(
        'SELECT originId, (timestamp/10000)*10000 AS at, AVG(latency) AS latency, MIN(success) AS success, COUNT(*) AS count FROM probe_results WHERE originId IN (SELECT id FROM origins WHERE applicationId=?) AND timestamp>? GROUP BY originId,timestamp/10000 ORDER BY at DESC LIMIT 1000',
        id,
        Date.now() - q.hours * 3600000,
      )
      .reverse();
  });
  const pagination = (req: FastifyRequest) =>
    z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
  api.get('/api/v1/incidents', async (req) => {
    const p = pagination(req);
    return { items: store.incidents(p.limit, p.offset), ...p };
  });
  api.get('/api/v1/incidents/:id', async (req) => {
    const i = store.incident(idOf(req));
    const { snapshot: _snapshot, ...safe } = i;
    return { ...safe, steps: store.steps(i.id) };
  });
  api.post('/api/v1/incidents/:id/cancel', async (req) => {
    const i = store.incident(idOf(req));
    if (i.outcome) throw new Fault('INCIDENT_TERMINAL', 'Incident is already complete', 409);
    store.run('UPDATE incidents SET cancelRequested=1 WHERE id=?', i.id);
    store.audit(actor(req), 'incident.cancel_requested', i.id);
    return {
      behavior: store.steps(i.id).some((s) => s.phase === 'Switch Traffic')
        ? 'Routing intent exists; operator reconciliation is required. No blind rollback.'
        : 'Current traffic route will remain unchanged.',
    };
  });
  api.get('/api/v1/audit-log', async (req) => {
    const p = pagination(req);
    const action = z.object({ action: z.string().max(80).default('') }).parse(req.query).action;
    return {
      items: store
        .all(
          'SELECT * FROM audit_events WHERE action LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?',
          `%${action}%`,
          p.limit,
          p.offset,
        )
        .map((r) => ({ ...r, diff: JSON.parse(r.diff as string) })),
      ...p,
    };
  });
  api.get('/api/v1/settings', async () => ({
    location: store.get('location', 'Not declared'),
    retentionDays: store.get('retentionDays', 7),
    webhookConfigured: !!store.get('webhook', null),
  }));
  api.patch('/api/v1/settings', async (req) => {
    const input = z
      .object({
        location: z.string().min(1).max(120).optional(),
        retentionDays: z.number().int().min(1).max(30).optional(),
      })
      .parse(req.body);
    for (const [key, value] of Object.entries(input)) store.set(key, value);
    store.audit(actor(req), 'settings.updated', 'installation', input);
    return { ok: true };
  });
  api.put('/api/v1/settings/webhook', async (req) => {
    if (options.demo) throw new Fault('DEMO_ISOLATION', 'Demo installations cannot send real notifications');
    const input = z.object({ url: z.url().max(2048), secret: z.string().min(32).max(256) }).parse(req.body);
    await validateWebhook(input.url);
    store.set('webhook', { url: input.url, encryptedSecret: vault.encrypt(input.secret, 'webhook') });
    store.audit(actor(req), 'webhook.configured', 'installation', { hostname: new URL(input.url).hostname });
    return { ok: true };
  });
  api.delete('/api/v1/settings/webhook', async (req) => {
    store.set('webhook', null);
    store.audit(actor(req), 'webhook.removed', 'installation');
    return { ok: true };
  });
  api.post('/api/v1/auth/password', async (req) => {
    const input = z
      .object({ currentPassword: z.string().max(128), password: z.string().min(12).max(128) })
      .parse(req.body);
    const u = store.one('SELECT * FROM users WHERE username=?', actor(req))!;
    if (!(await argon2.verify(u.passwordHash as string, input.currentPassword)))
      throw new Fault('PASSWORD_INVALID', 'Current password is incorrect', 403);
    const hash = await argon2.hash(input.password);
    store.tx(() => {
      store.run('UPDATE users SET passwordHash=? WHERE id=?', hash, u.id);
      store.run('DELETE FROM sessions WHERE userId=?', u.id);
      store.audit(actor(req), 'auth.password_changed', u.id as string);
    });
    return { ok: true };
  });
  if (options.demo)
    api.post('/api/v1/applications/:id/demo', async (req) => {
      const a = store.application(idOf(req));
      if (!a.demo) throw new Fault('DEMO_ONLY', 'This action requires a demo application');
      const input = z
        .object({
          role: z.enum(['primary', 'backup']),
          healthy: z.boolean().optional(),
          running: z.boolean().optional(),
          dependencies: z.boolean().optional(),
        })
        .parse(req.body);
      const o = a.origins.find((o) => o.role === input.role)!;
      store.run(
        'UPDATE demo_resources SET healthy=COALESCE(?,healthy),running=COALESCE(?,running),dependencies=COALESCE(?,dependencies) WHERE id=?',
        input.healthy === undefined ? null : Number(input.healthy),
        input.running === undefined ? null : Number(input.running),
        input.dependencies === undefined ? null : Number(input.dependencies),
        o.id,
      );
      store.audit(actor(req), 'demo.fixture_updated', a.id, input);
      return { ok: true };
    });
  api.get('/api/v1/openapi.json', async () => api.swagger());
  api.get('/api/v1/events', async (req, reply) => {
    if (streams.size >= 20)
      throw new Fault('STREAM_LIMIT', 'Too many event streams; polling remains available', 429, true);
    const tokenHash = hashToken(req.cookies.ptm_session!);
    let last = Math.max(0, Number(req.headers['last-event-id']) || 0);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    const send = () => {
      const s = store.one('SELECT expiresAt FROM sessions WHERE tokenHash=?', tokenHash);
      if (!s || Number(s.expiresAt) < Date.now()) {
        reply.raw.end();
        return;
      }
      const events = store.all(
        'SELECT id,action,entity FROM audit_events WHERE id>? ORDER BY id LIMIT 100',
        last,
      );
      for (const event of events) {
        last = Number(event.id);
        if (!reply.raw.write(`id: ${last}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`)) {
          reply.raw.end();
          return;
        }
      }
      if (!reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify(status())}\n\n`)) reply.raw.end();
    };
    const timer = setInterval(send, 2000);
    reply.raw.on('close', () => {
      clearInterval(timer);
      streams.delete(reply.raw);
    });
    send();
  });
  const webRoot = resolve('apps/web/dist');
  if (options.serveWeb && existsSync(webRoot)) {
    await api.register(staticFiles, { root: webRoot, prefix: '/' });
    api.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({
            code: 'NOT_FOUND',
            message: 'Endpoint not found',
            correlationId: req.id,
            retryable: false,
          })
        : reply.sendFile('index.html'),
    );
  }
  return { api, store, worker, runtime };
}
