import {
  Fault,
  type TrafficRouter,
  type RecordSnapshot,
  type RoutingConfig,
  type Origin,
} from '@ptm/contracts';
import { providerRequest, type Http } from '@ptm/providers';
import { z } from 'zod';

const record = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional().default(false),
  ttl: z.number(),
  modified_on: z.string().optional(),
});
import { routesEqual, targetRecords } from './plan.ts';
export { routesEqual, targetRecords } from './plan.ts';
export class CloudflareRouter implements TrafficRouter {
  constructor(
    private token: string,
    private hostname: string,
    private config: RoutingConfig,
    private http: Http = fetch,
  ) {
    if (!token || !/^[a-f0-9]{32}$/.test(config.zoneId) || !config.recordIds.length)
      throw new Fault(
        'ROUTING_CONFIGURATION',
        'Cloudflare token, exact zone ID and existing record IDs are required',
      );
  }
  private async records() {
    const records: z.infer<typeof record>[] = [];
    for (let page = 1; page <= 20; page++) {
      const raw = await providerRequest(
        this.http,
        `https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/dns_records?name=${encodeURIComponent(this.hostname)}&per_page=100&page=${page}`,
        this.token,
      );
      const r = z
        .object({
          success: z.literal(true),
          result: z.array(record),
          result_info: z.object({ total_pages: z.number() }).optional(),
        })
        .parse(raw);
      records.push(...r.result);
      if (page >= (r.result_info?.total_pages ?? 1)) return records;
    }
    throw new Fault('RECORD_LIMIT', 'Record listing exceeded the bounded limit');
  }
  async validateConfiguration() {
    const all = await this.records();
    const relevant = all.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
    if (
      relevant.some((r) => r.type === 'CNAME') ||
      relevant.length !== this.config.recordIds.length ||
      relevant.some((r) => !this.config.recordIds.includes(r.id)) ||
      new Set(this.config.recordIds).size !== this.config.recordIds.length
    )
      throw new Fault(
        'AMBIGUOUS_ROUTES',
        'Resolve conflicting CNAME or extra A/AAAA records. No records will be deleted.',
      );
    if (!relevant.length || new Set(relevant.map((r) => r.proxied)).size !== 1)
      throw new Fault('PROXY_MISMATCH', 'All selected A/AAAA records must have consistent proxy status');
    if (!relevant[0].proxied && !this.config.dnsOnlyAcknowledged)
      throw new Fault(
        'DNS_CACHING_ACK_REQUIRED',
        'DNS-only routing is subject to client caches and has no universal five-minute guarantee',
      );
    return relevant as RecordSnapshot[];
  }
  async readRoute() {
    return this.validateConfiguration();
  }
  async planSwitch(target: Origin, approved: RecordSnapshot[]) {
    const current = await this.readRoute();
    if (!routesEqual(current, approved, true))
      throw new Fault(
        'RECONCILIATION_REQUIRED',
        'Managed records changed outside this controller. Review routing before proceeding.',
        409,
      );
    return targetRecords(target, current);
  }
  async applySwitch(plan: RecordSnapshot[], beforeWrite: () => void) {
    let expected = this.config.snapshot;
    for (const r of plan) {
      const current = await this.readRoute();
      if (!routesEqual(current, expected, true))
        throw new Fault(
          'RECONCILIATION_REQUIRED',
          'Record set changed before a routing write; review the observed route.',
          409,
        );
      beforeWrite();
      await providerRequest(
        this.http,
        `https://api.cloudflare.com/client/v4/zones/${this.config.zoneId}/dns_records/${encodeURIComponent(r.id)}`,
        this.token,
        'PATCH',
        { content: r.content },
      );
      const next = await this.readRoute();
      if (
        !routesEqual(
          next,
          current.map((x) => (x.id === r.id ? { ...x, content: r.content } : x)),
        )
      )
        throw new Fault(
          'RECONCILIATION_REQUIRED',
          'Partial routing update or unexpected record change during switch',
          409,
        );
      expected = next;
    }
  }
  async inspectConvergence(plan: RecordSnapshot[]) {
    return routesEqual(await this.readRoute(), plan);
  }
}
