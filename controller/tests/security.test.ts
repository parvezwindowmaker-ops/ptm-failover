import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Vault } from '../apps/api/src/security.js';
import { Store } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';
import { resolveDestination, validateAddress, probe } from '../apps/api/src/probe.js';
import { originSchema } from '@ptm/contracts';

describe('secrets and installation', () => {
  it('authenticates encryption context and fails closed for missing/wrong keys', () => {
    const vault = new Vault(Buffer.alloc(32, 1));
    const blob = vault.encrypt({ token: 'secret-token' }, 'provider-a');
    expect(blob).not.toContain('secret-token');
    expect(vault.decrypt(blob, 'provider-a')).toEqual({ token: 'secret-token' });
    expect(() => vault.decrypt(blob, 'provider-b')).toThrow('decrypt');
    expect(() => new Vault(Buffer.alloc(32, 2)).decrypt(blob, 'provider-a')).toThrow('decrypt');
    expect(() => new Vault(Buffer.alloc(5))).toThrow('32 bytes');
    expect(() => Vault.fromFile('missing-key')).toThrow();
  });
  it('claim is single use, sessions require CSRF, secrets stay absent from responses', async () => {
    const store = new Store(':memory:');
    const result = await buildApp({
      store,
      vault: new Vault(Buffer.alloc(32, 1)),
      bootstrapToken: 'b'.repeat(43),
      demo: false,
      baseUrl: 'http://localhost:8080',
    });
    const body = { username: 'owner', password: 'strong-test-password', bootstrapToken: 'b'.repeat(43) };
    const claimed = await result.api.inject({
      method: 'POST',
      url: '/api/v1/setup/claim',
      headers: { origin: 'http://localhost:8080' },
      payload: body,
    });
    expect(claimed.statusCode).toBe(200);
    const cookie = claimed.headers['set-cookie']!.toString().split(';')[0];
    const csrf = claimed.json().csrfToken;
    expect(
      (
        await result.api.inject({
          method: 'POST',
          url: '/api/v1/setup/claim',
          headers: { origin: 'http://localhost:8080' },
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await result.api.inject({
          method: 'POST',
          url: '/api/v1/providers',
          headers: { origin: 'http://localhost:8080', cookie },
          payload: { type: 'hostinger', label: 'VPS', secret: { token: 'never-return-me' } },
        })
      ).statusCode,
    ).toBe(403);
    const added = await result.api.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { origin: 'http://localhost:8080', cookie, 'x-csrf-token': csrf },
      payload: { type: 'hostinger', label: 'VPS', secret: { token: 'never-return-me' } },
    });
    expect(added.statusCode).toBe(200);
    expect(added.body).not.toContain('never-return-me');
    expect(store.one('SELECT encryptedSecret FROM provider_connections')!.encryptedSecret).not.toContain(
      'never-return-me',
    );
    const unauth = await result.api.inject('/api/v1/applications');
    expect(unauth.statusCode).toBe(401);
    await result.api.close();
    store.close();
  });
  it('migrations and consistent backup restore preserve WAL-backed state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptm-test-'));
    const path = join(dir, 'db.sqlite');
    const s = new Store(path);
    s.set('persisted', { value: 42 });
    await s.db.backup(join(dir, 'backup.sqlite'));
    expect(readFileSync(join(dir, 'backup.sqlite')).length).toBeGreaterThan(0);
    s.close();
    const restored = new Store(join(dir, 'backup.sqlite'));
    expect(restored.get('persisted', null)).toEqual({ value: 42 });
    expect(restored.one('SELECT COUNT(*) AS n FROM schema_migrations')!.n).toBe(2);
    restored.close();
  });
});
describe('SSRF and transport', () => {
  it('recognizes dependency failure on an identified 503 origin without trusting another identity', async () => {
    let identity = 'primary';
    const server = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ serverId: identity, release: 'v1', dependencies: { database: false } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = {
        ...originSchema.parse({
          role: 'primary',
          address: '127.0.0.1',
          tlsHostname: 'example.com',
          protocol: 'http',
          port: (server.address() as { port: number }).port,
          expectedIdentity: 'primary',
        }),
        id: 'p',
        applicationId: 'a',
        observation: null,
        power: 'unknown' as const,
        healthySince: null,
      };
      expect((await probe(origin, 'v1', 1000, { demo: true })).reason).toContain('SHARED_DEPENDENCY_FAILED');
      identity = 'untrusted';
      expect((await probe(origin, 'v1', 1000, { demo: true })).reason).toContain('STATUS_MISMATCH');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each([
    '169.254.169.254',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    '::ffff:169.254.169.254',
    '224.0.0.1',
    '100.64.0.1',
  ])('blocks reserved/metadata address %s', (ip) => {
    expect(() => validateAddress(ip)).toThrow();
  });
  it('private networks require exact approved CIDRs; metadata cannot be allowlisted', () => {
    expect(() => validateAddress('10.2.0.5')).toThrow();
    expect(() => validateAddress('10.2.0.5', ['10.2.0.0/24'])).not.toThrow();
    expect(() => validateAddress('10.3.0.5', ['10.2.0.0/24'])).toThrow();
    expect(() => validateAddress('169.254.169.254', ['169.254.0.0/16'])).toThrow();
  });
  it('rejects URL userinfo and DNS rebinding to any unapproved address', async () => {
    await expect(resolveDestination('user@host.example', [])).rejects.toThrow();
    const resolver = async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ];
    await expect(resolveDestination('host.example', [], false, resolver)).rejects.toThrow();
  });
  it('does not follow redirects and enforces response bounds', async () => {
    let touched = 0;
    const server = createServer((req, res) => {
      touched++;
      if (req.url?.startsWith('/big')) {
        res.end('x'.repeat(70000));
        return;
      }
      res.writeHead(302, { location: 'http://169.254.169.254/' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const origin = {
      ...originSchema.parse({
        role: 'primary',
        address: '127.0.0.1',
        tlsHostname: 'example.com',
        protocol: 'http',
        port,
        releasePolicy: 'any',
        readinessPath: '/ready',
      }),
      id: 'test',
      applicationId: 'test',
      observation: null,
      power: 'unknown',
      healthySince: null,
    };
    const result = await probe(origin, '', 1000, { demo: true });
    expect(result.success).toBe(false);
    expect(result.status).toBe(302);
    expect(touched).toBe(1);
    const big = await probe({ ...origin, readinessPath: '/big' }, '', 1000, { demo: true });
    expect(big.reason).toContain('RESPONSE_LIMIT');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
