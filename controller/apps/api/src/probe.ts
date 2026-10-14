import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Fault, type Origin, type Probe } from '@ptm/contracts';

export function validateAddress(address: string, approvedCidrs: string[] = [], demoLoopback = false) {
  let ip;
  try {
    ip = ipaddr.process(address);
  } catch {
    throw new Fault('INVALID_ADDRESS', 'Destination is not an IP address');
  }
  const range = ip.range();
  if (demoLoopback && range === 'loopback') return;
  if (range === 'unicast') return;
  if (range === 'private' || range === 'uniqueLocal') {
    if (
      approvedCidrs.some((cidr) => {
        try {
          const [net, bits] = ipaddr.parseCIDR(cidr);
          if (net.kind() === 'ipv4' && ip.kind() === 'ipv4')
            return (ip as ipaddr.IPv4).match(net as ipaddr.IPv4, bits);
          if (net.kind() === 'ipv6' && ip.kind() === 'ipv6')
            return (ip as ipaddr.IPv6).match(net as ipaddr.IPv6, bits);
          return false;
        } catch {
          return false;
        }
      })
    )
      return;
  }
  throw new Fault(
    'SSRF_BLOCKED',
    'Destination is metadata, link-local, reserved, or a private network without explicit CIDR approval',
  );
}
export async function resolveDestination(
  address: string,
  cidrs: string[],
  demo = false,
  resolver: (
    hostname: string,
    options: { all: true },
  ) => Promise<{ address: string; family: number }[]> = lookup,
) {
  if (/[\s/@\\?#%]/.test(address))
    throw new Fault(
      'INVALID_ADDRESS',
      'Configure a hostname or IP without URL credentials, paths or scope IDs',
    );
  const results = ipaddr.isValid(address)
    ? [{ address, family: ipaddr.parse(address).kind() === 'ipv4' ? 4 : 6 }]
    : await resolver(address, { all: true });
  if (!results.length) throw new Fault('DNS_FAILED', 'Destination did not resolve');
  for (const r of results) validateAddress(r.address, cidrs, demo);
  return results[0];
}
export async function probe(
  origin: Origin,
  desiredRelease: string,
  timeoutMs: number,
  options: { publicHostname?: string; demo?: boolean } = {},
): Promise<Probe> {
  const began = performance.now();
  const at = Date.now();
  const result: Probe = {
    at,
    success: false,
    status: null,
    latency: 0,
    reason: null,
    identity: null,
    release: null,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = options.publicHostname ?? origin.address;
    const pinned = await Promise.race([
      resolveDestination(address, options.publicHostname ? [] : origin.approvedPrivateCidrs, !!options.demo),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Fault('DNS_TIMEOUT', 'Destination resolution timed out')),
          timeoutMs,
        );
      }),
    ]);
    if (timer) clearTimeout(timer);
    const deadline = timeoutMs - (performance.now() - began);
    if (deadline <= 0) throw new Fault('PROBE_TIMEOUT', 'Readiness timed out');
    const protocol = options.publicHostname ? 'https' : origin.protocol;
    const transport = protocol === 'https' ? https : http;
    const data = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = transport.request(
        {
          hostname: pinned.address,
          family: pinned.family,
          port: options.publicHostname ? 443 : origin.port,
          method: 'GET',
          path: `${origin.readinessPath}?ptm=${at}`,
          headers: {
            Host: options.publicHostname ?? origin.tlsHostname,
            'Cache-Control': 'no-cache, no-store',
            Accept: 'application/json',
          },
          ...(protocol === 'https'
            ? { servername: options.publicHostname ?? origin.tlsHostname, rejectUnauthorized: true }
            : {}),
          agent: false,
        },
        (response) => {
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 65536)
              request.destroy(new Fault('RESPONSE_LIMIT', 'Readiness response exceeded 64 KiB'));
            else chunks.push(chunk);
          });
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
          response.on('error', reject);
        },
      );
      const timeout = setTimeout(
        () => request.destroy(new Fault('PROBE_TIMEOUT', 'Readiness timed out')),
        deadline,
      );
      request.on('close', () => clearTimeout(timeout));
      request.on('error', reject);
      request.end();
    });
    result.status = data.status;
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(data.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        body = parsed as Record<string, unknown>;
    } catch {
      if (
        data.status === origin.expectedStatus &&
        (origin.expectedIdentity ||
          (origin.releasePolicy === 'exact' && desiredRelease) ||
          Object.keys(origin.assertions).length)
      )
        throw new Fault('ASSERTION_FAILED', 'Readiness assertions require a JSON response');
    }
    result.identity = typeof body.serverId === 'string' ? body.serverId.slice(0, 128) : null;
    result.release = typeof body.release === 'string' ? body.release.slice(0, 128) : null;
    // Trust dependency evidence only when the response identifies the configured origin.
    if (
      origin.expectedIdentity &&
      result.identity === origin.expectedIdentity &&
      body.dependencies &&
      typeof body.dependencies === 'object' &&
      !Array.isArray(body.dependencies) &&
      Object.values(body.dependencies as Record<string, unknown>).some((x) => x !== true && x !== 'healthy')
    )
      throw new Fault('SHARED_DEPENDENCY_FAILED', 'Essential dependency is not healthy');
    if (data.status !== origin.expectedStatus)
      throw new Fault(
        'STATUS_MISMATCH',
        `Readiness HTTP status ${data.status}; expected ${origin.expectedStatus}. Redirects are not followed.`,
      );
    if (origin.expectedIdentity && result.identity !== origin.expectedIdentity)
      throw new Fault('IDENTITY_MISMATCH', 'Readiness response came from an unexpected server identity');
    if (origin.releasePolicy === 'exact' && desiredRelease && result.release !== desiredRelease)
      throw new Fault(
        'RELEASE_MISMATCH',
        'Readiness release does not match the configured application release',
      );
    if (
      body.dependencies &&
      Object.values(body.dependencies as Record<string, unknown>).some((x) => x !== true && x !== 'healthy')
    )
      throw new Fault('SHARED_DEPENDENCY_FAILED', 'Essential dependency is not healthy');
    for (const [key, value] of Object.entries(origin.assertions))
      if (body[key] !== value)
        throw new Fault('ASSERTION_FAILED', 'A configured response assertion did not match');
    result.success = true;
  } catch (error) {
    result.reason =
      error instanceof Fault
        ? error.code + ': ' + error.message
        : 'NETWORK_ERROR: Connection failed or TLS verification failed';
  } finally {
    if (timer) clearTimeout(timer);
    result.latency = Math.round(performance.now() - began);
  }
  return result;
}
