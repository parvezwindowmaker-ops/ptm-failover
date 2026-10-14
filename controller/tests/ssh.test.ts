import { describe, it, expect } from 'vitest';
import ssh2, { type ParsedKey, type Connection } from 'ssh2';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../apps/api/src/db.js';
import { Vault } from '../apps/api/src/security.js';
import { buildApp } from '../apps/api/src/app.js';
import { hostFingerprint, testSshConnection, validateSshKey } from '../apps/api/src/ssh.js';
import { seed } from './harness.js';

const host = ssh2.utils.generateKeyPairSync('ed25519');
const user = ssh2.utils.generateKeyPairSync('ed25519');
const hostKey = ssh2.utils.parseKey(host.private) as ParsedKey;
const userKey = ssh2.utils.parseKey(user.private) as ParsedKey;

describe('SSH credentials and authenticated connections', () => {
  it('rejects public, malformed and oversized keys and validates encrypted key passphrases', () => {
    expect(() => validateSshKey({privateKey: user.public})).toThrow('private key');
    expect(() => validateSshKey({privateKey: 'not a key'})).toThrow('private key');
    expect(() => validateSshKey({privateKey: 'x'.repeat(32769)})).toThrow('32 KiB');
    const encrypted = ssh2.utils.generateKeyPairSync('ed25519', {passphrase: 'test-passphrase', cipher: 'aes256-cbc', rounds: 1});
    expect(() => validateSshKey({privateKey: encrypted.private, passphrase: 'wrong'})).toThrow('passphrase');
    expect(() => validateSshKey({privateKey: encrypted.private, passphrase: 'test-passphrase'})).not.toThrow();
  });
  it('opens a real SSH connection, pins the host key, verifies key authentication and opens no sessions', async () => {
    const clients = new Set<Connection>();
    let sessions = 0;
    let signatures = 0;
    const server = new ssh2.Server({hostKeys: [host.private]}, (client) => {
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      client.on('authentication', (ctx) => {
        if (ctx.method !== 'publickey' || ctx.username !== 'tester' || !userKey.getPublicSSH().equals(ctx.key.data)) return ctx.reject();
        if (ctx.signature) {
          if (!userKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject();
          signatures++;
        }
        ctx.accept();
      });
      client.on('session', (_accept, reject) => { sessions++; reject(); });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const store = new Store(':memory:');
    const origin = {...seed(store).origins[0], address: '127.0.0.1'};
    const config = {username: 'tester', port: (server.address() as {port: number}).port, hostFingerprint: hostFingerprint(hostKey.getPublicSSH())};
    const options = {resolve: async () => ({address: '127.0.0.1', family: 4}), timeoutMs: 2000};
    try {
      const result = await testSshConnection(origin, config, {privateKey: user.private}, options);
      expect(result).toMatchObject({connected: true, authenticated: true, hostVerified: true});
      expect(signatures).toBe(1);
      expect(sessions).toBe(0);
      await expect(testSshConnection(origin, {...config, hostFingerprint: 'SHA256:' + 'A'.repeat(43)}, {privateKey: user.private}, options)).rejects.toMatchObject({code: 'SSH_HOST_KEY_MISMATCH'});
      await expect(testSshConnection(origin, {...config, username: 'wrong'}, {privateKey: user.private}, options)).rejects.toMatchObject({code: 'SSH_CONNECTION_FAILED'});
      await expect(testSshConnection(origin, config, {privateKey: user.private})).rejects.toMatchObject({code: 'SSRF_BLOCKED'});
    } finally {
      for (const client of clients) client.end();
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    }
  });
  it('bounds a stalled SSH handshake and closes the socket', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((socket) => {sockets.add(socket); socket.on('close', () => sockets.delete(socket));});
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const store = new Store(':memory:');
    try {
      await expect(testSshConnection({...seed(store).origins[0], address: '127.0.0.1'}, {username: 'tester', port: (server.address() as {port:number}).port, hostFingerprint: hostFingerprint(hostKey.getPublicSSH())}, {privateKey: user.private}, {timeoutMs: 100, resolve: async () => ({address: '127.0.0.1', family: 4})})).rejects.toMatchObject({code: 'SSH_TIMEOUT'});
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((done) => server.close(() => done())); store.close(); }
  });
  it('migrates an existing v1 database without replacing its data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptm-migration-'));
    writeFileSync(join(dir, '001_initial.sql'), readFileSync(resolve('apps/api/src/migrations/001_initial.sql')));
    const path = join(dir, 'ptm.sqlite');
    const old = new Store(path, join(dir, '001_initial.sql'));
    old.set('existing', 'preserved');
    old.close();
    const upgraded = new Store(path);
    expect(upgraded.get('existing', '')).toBe('preserved');
    expect(upgraded.one('SELECT COUNT(*) AS n FROM schema_migrations')!.n).toBe(2);
    expect(upgraded.all('SELECT * FROM ssh_connections')).toEqual([]);
    upgraded.close();
  });
  it('requires owner/CSRF/revision, encrypts uploads, masks reads, retains keys on edits and deletes credentials', async () => {
    const store = new Store(':memory:');
    const app = seed(store);
    store.run('UPDATE applications SET demo=0,automationEnabled=0 WHERE id=?', app.id);
    const origin = app.origins[0];
    const vault = new Vault(Buffer.alloc(32, 3));
    const {api} = await buildApp({store, vault, bootstrapToken: 'b'.repeat(43), demo: false, baseUrl: 'http://localhost:8080'});
    try {
      const claim = await api.inject({method: 'POST', url: '/api/v1/setup/claim', headers: {origin: 'http://localhost:8080'}, payload: {username: 'owner', password: 'strong-test-password', bootstrapToken: 'b'.repeat(43)}});
      const headers = {origin: 'http://localhost:8080', cookie: claim.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': claim.json().csrfToken};
      const url = `/api/v1/origins/${origin.id}/ssh`;
      const payload = {revision: 1, username: 'ubuntu', port: 22, hostFingerprint: hostFingerprint(hostKey.getPublicSSH()), privateKey: user.private};
      expect((await api.inject({method: 'PUT', url, payload, headers: {origin: headers.origin}})).statusCode).toBe(401);
      expect((await api.inject({method: 'PUT', url, payload, headers: {origin: headers.origin, cookie: headers.cookie}})).statusCode).toBe(403);
      const saved = await api.inject({method: 'PUT', url, payload, headers});
      expect(saved.statusCode).toBe(200);
      expect(saved.body).not.toContain('PRIVATE KEY');
      expect(saved.json().keyConfigured).toBe(true);
      const blob = store.one('SELECT encryptedSecret FROM ssh_connections WHERE originId=?', origin.id)!.encryptedSecret as string;
      expect(blob).not.toContain('PRIVATE KEY');
      expect(vault.decrypt<{privateKey:string}>(blob, `ssh:${origin.id}`).privateKey).toBe(user.private);
      expect((await api.inject({url, headers})).body).not.toContain('PRIVATE KEY');
      expect((await api.inject({method: 'PUT', url, payload, headers})).statusCode).toBe(409);
      const edited = await api.inject({method: 'PUT', url, headers, payload: {revision: 2, username: 'ec2-user', port: 2222, hostFingerprint: payload.hostFingerprint}});
      expect(edited.statusCode).toBe(200);
      const latest = store.one('SELECT encryptedSecret FROM ssh_connections WHERE originId=?', origin.id)!.encryptedSecret as string;
      expect(vault.decrypt<{privateKey:string}>(latest, `ssh:${origin.id}`).privateKey).toBe(user.private);
      // The ordinary network guard blocks loopback even for a valid stored key.
      expect((await api.inject({method: 'POST', url: url + '/test', headers, payload: {}})).json().code).toBe('SSRF_BLOCKED');
      expect(store.all('SELECT diff FROM audit_events').some((row) => JSON.stringify(row).includes('PRIVATE KEY'))).toBe(false);
      expect((await api.inject({method: 'DELETE', url, headers, payload: {revision: 3}})).statusCode).toBe(200);
      expect(store.one('SELECT originId FROM ssh_connections WHERE originId=?', origin.id)).toBeUndefined();
    } finally { await api.close(); store.close(); }
  });
  it('rejects real key uploads in demo mode', async () => {
    const store = new Store(':memory:');
    const app = seed(store);
    const {api} = await buildApp({store, vault: new Vault(Buffer.alloc(32, 3)), bootstrapToken: 'b'.repeat(43), demo: true, baseUrl: 'http://localhost:8080'});
    try {
      const claim = await api.inject({method: 'POST', url: '/api/v1/setup/claim', headers: {origin: 'http://localhost:8080'}, payload: {username: 'owner', password: 'strong-test-password', bootstrapToken: 'b'.repeat(43)}});
      const headers = {origin: 'http://localhost:8080', cookie: claim.headers['set-cookie']!.toString().split(';')[0], 'x-csrf-token': claim.json().csrfToken};
      const result = await api.inject({method: 'PUT', url: `/api/v1/origins/${app.origins[0].id}/ssh`, headers, payload: {revision: 1, username: 'ubuntu', port: 22, hostFingerprint: hostFingerprint(hostKey.getPublicSSH()), privateKey: user.private}});
      expect(result.json().code).toBe('DEMO_ISOLATION');
      expect(store.all('SELECT * FROM ssh_connections')).toEqual([]);
    } finally { await api.close(); store.close(); }
  });
});
