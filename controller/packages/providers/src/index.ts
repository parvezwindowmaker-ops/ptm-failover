import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  type Instance,
} from '@aws-sdk/client-ec2';
import { Fault, type ServerProvider, type Resource } from '@ptm/contracts';
import { z } from 'zod';

import { providerRequest, type Http } from './http.ts';
export { providerRequest, ProviderHttpError, type Http } from './http.ts';
export class GenericProvider implements ServerProvider {
  capabilities() {
    return { inspect: false, start: false };
  }
  async validateCredentials() {}
  async listResources(): Promise<Resource[]> {
    return [];
  }
  async inspectResource(id: string): Promise<Resource> {
    return { id, name: id, power: 'unknown', addresses: [] };
  }
  async startResource(): Promise<never> {
    throw new Fault('UNAVAILABLE_CAPABILITY', 'Generic servers have no power controls');
  }
}
const hostingerResource = z.object({
  id: z.number(),
  hostname: z.string().optional(),
  state: z.string(),
  ipv4: z.array(z.object({ address: z.string() })).optional(),
  ipv6: z.array(z.object({ address: z.string() })).optional(),
});
export class HostingerProvider implements ServerProvider {
  constructor(
    private token: string,
    private scope: string[],
    private http: Http = fetch,
  ) {
    if (!token) throw new Fault('CREDENTIAL_REQUIRED', 'Hostinger API token is required');
  }
  capabilities() {
    return { inspect: true, start: true };
  }
  private check(id: string) {
    if (!/^\d+$/.test(id) || !this.scope.includes(id))
      throw new Fault('RESOURCE_SCOPE', 'Resource must be explicitly allowed in the provider scope', 403);
  }
  private normalize(value: unknown): Resource {
    const r = hostingerResource.parse(value);
    // Unrecognized provider states remain unknown. HTTP readiness is checked separately.
    return {
      id: String(r.id),
      name: r.hostname ?? String(r.id),
      power: r.state === 'running' ? 'running' : r.state === 'stopped' ? 'stopped' : 'unknown',
      addresses: [...(r.ipv4 ?? []), ...(r.ipv6 ?? [])].map((x) => x.address),
    };
  }
  async validateCredentials() {
    await this.listResources();
  }
  async listResources() {
    const value = await providerRequest(
      this.http,
      'https://developers.hostinger.com/api/vps/v1/virtual-machines',
      this.token,
    );
    return z
      .array(hostingerResource)
      .parse(value)
      .map((x) => this.normalize(x))
      .filter((x) => this.scope.includes(x.id));
  }
  async inspectResource(id: string) {
    this.check(id);
    return this.normalize(
      await providerRequest(
        this.http,
        `https://developers.hostinger.com/api/vps/v1/virtual-machines/${id}`,
        this.token,
      ),
    );
  }
  async startResource(id: string) {
    this.check(id);
    const action = z
      .object({ id: z.number() })
      .parse(
        await providerRequest(
          this.http,
          `https://developers.hostinger.com/api/vps/v1/virtual-machines/${id}/start`,
          this.token,
          'POST',
        ),
      );
    return { requestId: String(action.id) };
  }
}
export class AwsProvider implements ServerProvider {
  private client: EC2Client;
  constructor(
    secret: Record<string, string>,
    region: string,
    private scope: string[],
    client?: EC2Client,
  ) {
    if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Fault('INVALID_REGION', 'An AWS region is required');
    this.client =
      client ??
      new EC2Client({
        region,
        maxAttempts: 1,
        credentials: {
          accessKeyId: secret.accessKeyId,
          secretAccessKey: secret.secretAccessKey,
          ...(secret.sessionToken ? { sessionToken: secret.sessionToken } : {}),
        },
      });
  }
  capabilities() {
    return { inspect: true, start: true };
  }
  private check(id: string) {
    if (!/^i-[0-9a-f]+$/.test(id) || !this.scope.includes(id))
      throw new Fault('RESOURCE_SCOPE', 'EC2 instance is outside the configured scope', 403);
  }
  private normalize(i: Instance): Resource {
    return {
      id: i.InstanceId!,
      name: i.Tags?.find((t) => t.Key === 'Name')?.Value ?? i.InstanceId!,
      power:
        i.State?.Name === 'running'
          ? 'running'
          : i.State?.Name === 'stopped'
            ? 'stopped'
            : i.State?.Name === 'pending'
              ? 'pending'
              : 'unknown',
      addresses: [
        i.PublicIpAddress,
        i.PrivateIpAddress,
        ...(i.NetworkInterfaces ?? []).flatMap((n) => (n.Ipv6Addresses ?? []).map((a) => a.Ipv6Address)),
      ].filter((x): x is string => !!x),
    };
  }
  async validateCredentials() {
    await this.listResources();
  }
  async listResources() {
    if (!this.scope.length) throw new Fault('RESOURCE_SCOPE', 'Explicit EC2 instance IDs are required');
    const r = await this.client.send(new DescribeInstancesCommand({ InstanceIds: this.scope }), {
      abortSignal: AbortSignal.timeout(10000),
    });
    return (r.Reservations ?? []).flatMap((x) => x.Instances ?? []).map((i) => this.normalize(i));
  }
  async inspectResource(id: string) {
    this.check(id);
    const r = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [id] }), {
      abortSignal: AbortSignal.timeout(10000),
    });
    const i = r.Reservations?.[0]?.Instances?.[0];
    if (!i) throw new Fault('RESOURCE_NOT_FOUND', 'EC2 instance was not returned', 404);
    return this.normalize(i);
  }
  async startResource(id: string) {
    this.check(id);
    const r = await this.client.send(new StartInstancesCommand({ InstanceIds: [id] }), {
      abortSignal: AbortSignal.timeout(10000),
    });
    return { requestId: r.$metadata.requestId };
  }
}
