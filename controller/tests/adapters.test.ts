import { describe, it, expect, vi } from 'vitest';
import { EC2Client, DescribeInstancesCommand, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { HostingerProvider, AwsProvider, GenericProvider, ProviderHttpError } from '@ptm/providers';
import { CloudflareRouter } from '@ptm/routing';
import { routingSchema, type RoutingConfig, type Origin } from '@ptm/contracts';
import { harness } from './harness.js';

describe('provider contracts (mocked, no live credentials)', () => {
  it('Hostinger uses fixed HTTPS bearer endpoint and starts with no fabricated body', async () => {
    const requests: { url: string; method: string; body: unknown }[] = [];
    const http: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      if (String(input).endsWith('/start'))
        return Response.json({ id: 123, name: 'start', state: 'delayed' });
      return Response.json({ id: 42, hostname: 'backup', state: 'running', ipv4: [{ address: '8.8.8.8' }] });
    };
    const p = new HostingerProvider('test-token', ['42'], http);
    expect((await p.inspectResource('42')).power).toBe('running');
    expect(await p.startResource('42')).toEqual({ requestId: '123' });
    expect(requests[1]).toEqual({
      url: 'https://developers.hostinger.com/api/vps/v1/virtual-machines/42/start',
      method: 'POST',
      body: undefined,
    });
    await expect(p.startResource('99')).rejects.toThrow('scope');
  });
  it('unrecognized Hostinger power status stays unknown', async () => {
    const p = new HostingerProvider('token', ['42'], async () => Response.json({ id: 42, state: 'mystery' }));
    expect((await p.inspectResource('42')).power).toBe('unknown');
  });
  it('Hostinger retry-after is retained without replaying a mutation', async () => {
    const p = new HostingerProvider(
      'token',
      ['42'],
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '12' } }),
    );
    try {
      await p.startResource('42');
      throw new Error('unexpected');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).retryAfterMs).toBe(12000);
    }
  });
  it('EC2 uses official describe/start commands with explicit instance scope', async () => {
    const send = vi.fn(async (command: unknown) =>
      command instanceof DescribeInstancesCommand
        ? {
            Reservations: [
              {
                Instances: [
                  { InstanceId: 'i-123abc', State: { Name: 'running' }, PublicIpAddress: '8.8.8.8' },
                ],
              },
            ],
          }
        : { $metadata: { requestId: 'aws-request' } },
    );
    const p = new AwsProvider({ accessKeyId: 'test', secretAccessKey: 'test' }, 'ap-south-1', ['i-123abc'], {
      send,
    } as unknown as EC2Client);
    expect((await p.inspectResource('i-123abc')).power).toBe('running');
    expect(await p.startResource('i-123abc')).toEqual({ requestId: 'aws-request' });
    expect(send.mock.calls[0][0]).toBeInstanceOf(DescribeInstancesCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(StartInstancesCommand);
    await expect(p.startResource('i-deadbeef')).rejects.toThrow('scope');
  });
  it('generic provider exposes unavailable start capability', async () => {
    const p = new GenericProvider();
    expect(p.capabilities().start).toBe(false);
    await expect(p.startResource()).rejects.toThrow('no power');
  });
});
describe('Cloudflare DNS contracts', () => {
  const zone = 'a'.repeat(32);
  const name = 'api.example.com';
  const records = [
    {
      id: 'record-a',
      type: 'A' as const,
      name,
      content: '8.8.8.8',
      proxied: true,
      ttl: 1,
      modified_on: '2026-01-01T00:00:00Z',
    },
  ];
  function config(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
    return {
      ...routingSchema.parse({ type: 'cloudflare', zoneId: zone, recordIds: ['record-a'] }),
      snapshot: records,
      revision: 1,
      ...overrides,
    };
  }
  it('dry plan only reads; apply patches content and preserves unrelated record flags', async () => {
    let current = records.map((r) => ({ ...r }));
    const writes: unknown[] = [];
    const http: typeof fetch = async (_input, init) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        current = current.map((r) => ({ ...r, content: body.content, modified_on: 'updated' }));
        return Response.json({ success: true, result: current[0] });
      }
      return Response.json({ success: true, result: current, result_info: { total_pages: 1 } });
    };
    const router = new CloudflareRouter('token', name, config(), http);
    const h = harness();
    const target = { ...h.app.origins[1], ipv4: '1.1.1.1' } as Origin;
    const plan = await router.planSwitch(target, records);
    expect(writes).toEqual([]);
    await router.applySwitch(plan, () => {});
    expect(writes).toEqual([{ content: '1.1.1.1' }]);
    expect(await router.inspectConvergence(plan)).toBe(true);
    h.store.close();
  });
  it.each(['extra', 'cname', 'proxy', 'dns-only'] as const)(
    'rejects ambiguous or unacknowledged %s topology',
    async (kind) => {
      const extra =
        kind === 'extra'
          ? { ...records[0], id: 'extra' }
          : kind === 'cname'
            ? { ...records[0], id: 'cname', type: 'CNAME' }
            : null;
      const rs =
        kind === 'proxy'
          ? [...records, { ...records[0], id: 'aaaa', type: 'AAAA', proxied: false }]
          : kind === 'dns-only'
            ? records.map((r) => ({ ...r, proxied: false }))
            : extra
              ? [...records, extra]
              : records;
      const router = new CloudflareRouter(
        'token',
        name,
        config(kind === 'proxy' ? { recordIds: ['record-a', 'aaaa'] } : {}),
        async () => Response.json({ success: true, result: rs }),
      );
      await expect(router.validateConfiguration()).rejects.toThrow();
    },
  );
  it('rejects stale AAAA plans without a target IPv6 address', async () => {
    const h = harness();
    const rs = [
      ...records,
      { ...records[0], id: 'record-v6', type: 'AAAA' as const, content: '2606:4700:4700::1111' },
    ];
    const router = new CloudflareRouter('token', name, config({ recordIds: rs.map((r) => r.id) }), async () =>
      Response.json({ success: true, result: rs }),
    );
    await expect(router.planSwitch(h.app.origins[1], rs)).rejects.toThrow('IPv6');
    h.store.close();
  });
});
