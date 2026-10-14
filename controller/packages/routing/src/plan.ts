import { Fault } from '../../contracts/src/fault.ts';
import type { RecordSnapshot, Origin } from '@ptm/contracts';
export function routesEqual(a: RecordSnapshot[], b: RecordSnapshot[], exact = false) {
  const normalize = (records: RecordSnapshot[]) =>
    records
      .map((r) => [r.id, r.type, r.name, r.content, r.proxied, r.ttl, ...(exact ? [r.modified_on] : [])])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
export function targetRecords(target: Origin, before: RecordSnapshot[]): RecordSnapshot[] {
  return before.map((r) => {
    const ip = r.type === 'A' ? target.ipv4 : target.ipv6;
    if (!ip)
      throw new Fault(
        'ADDRESS_FAMILY_MISSING',
        `Target needs an explicit ${r.type === 'A' ? 'IPv4' : 'IPv6'} address for every approved record.`,
      );
    return { ...r, content: ip };
  });
}
