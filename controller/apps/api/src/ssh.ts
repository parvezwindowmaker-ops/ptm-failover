import { createHash, timingSafeEqual } from 'node:crypto';
import { Socket } from 'node:net';
import ssh2 from 'ssh2';
import { Fault, type Origin, type SshConfig } from '@ptm/contracts';
import { resolveDestination } from './probe.js';

export type SshSecret = { privateKey: string; passphrase?: string };
export function validateSshKey(secret: SshSecret) {
  if (Buffer.byteLength(secret.privateKey, 'utf8') > 32768)
    throw new Fault('SSH_KEY_LIMIT', 'Private keys must be at most 32 KiB', 400);
  const parsed = ssh2.utils.parseKey(secret.privateKey, secret.passphrase);
  const keys = Array.isArray(parsed) ? parsed : [parsed];
  if (keys.length !== 1 || keys[0] instanceof Error || !keys[0].isPrivateKey())
    throw new Fault(
      'SSH_KEY_INVALID',
      'Upload one supported private key and its correct passphrase if encrypted',
      400,
    );
}
export function hostFingerprint(key: Buffer) {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}
export async function testSshConnection(
  origin: Origin,
  config: SshConfig,
  secret: SshSecret,
  options: {
    timeoutMs?: number;
    resolve?: (address: string, cidrs: string[]) => Promise<{ address: string; family: number }>;
  } = {},
) {
  validateSshKey(secret);
  const timeoutMs = Math.min(options.timeoutMs ?? 10000, 15000);
  const began = performance.now();
  // Resolve once, validate every answer, then use that exact IP for TCP. No jump hosts or forwarding.
  const resolver = options.resolve ?? ((address, cidrs) => resolveDestination(address, cidrs));
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  let pinned: { address: string; family: number };
  try {
    pinned = await Promise.race([
      resolver(origin.address, origin.approvedPrivateCidrs),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(new Fault('SSH_TIMEOUT', 'SSH destination resolution timed out', 504, true)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
  const remaining = timeoutMs - (performance.now() - began);
  if (remaining <= 0) throw new Fault('SSH_TIMEOUT', 'SSH connection timed out', 504, true);
  return new Promise<{ connected: true; authenticated: true; hostVerified: true; durationMs: number }>(
    (resolve, reject) => {
      const client = new ssh2.Client();
      const socket = new Socket();
      let mismatch = false;
      let done = false;
      const timer = setTimeout(
        () => finish(new Fault('SSH_TIMEOUT', 'SSH connection timed out', 504, true)),
        remaining,
      );
      function finish(error?: Fault) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client.destroy();
        socket.destroy();
        if (error) reject(error);
        else
          resolve({
            connected: true,
            authenticated: true,
            hostVerified: true,
            durationMs: Math.round(performance.now() - began),
          });
      }
      const failed = () =>
        finish(
          new Fault(
            mismatch ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_CONNECTION_FAILED',
            mismatch
              ? 'Server host key does not match the trusted fingerprint. Verify it through an independent channel.'
              : 'SSH connection or key authentication failed. Check the username, key, firewall and server.',
            400,
          ),
        );
      socket.on('error', failed);
      socket.on('close', () => {
        if (!done) failed();
      });
      client.on('error', failed);
      client.on('close', () => {
        if (!done) failed();
      });
      client.on('ready', () => finish());
      socket.once('connect', () => {
        try {
          client.connect({
            sock: socket,
            username: config.username,
            privateKey: secret.privateKey,
            passphrase: secret.passphrase,
            readyTimeout: Math.max(1, Math.ceil(remaining)),
            tryKeyboard: false,
            agentForward: false,
            authHandler: ['publickey'],
            hostVerifier: (key: Buffer) => {
              const observed = Buffer.from(hostFingerprint(key));
              const expected = Buffer.from(config.hostFingerprint);
              const matches = expected.length === observed.length && timingSafeEqual(expected, observed);
              mismatch = !matches;
              return matches;
            },
          });
        } catch {
          failed();
        }
      });
      socket.connect({ host: pinned.address, family: pinned.family, port: config.port });
    },
  );
}
