import { describe, it, expect } from 'vitest';
import { Orchestrator } from '@ptm/orchestrator';
import { harness } from './harness.js';

describe('durable recovery decisions', () => {
  it.each(['cancel', 'deadline'])('handles %s immediately while a retry is deferred', async (reason) => {
    const h = harness();
    const id = h.incident();
    h.store.run('UPDATE incidents SET nextAttemptAt=? WHERE id=?', h.now + 120000, id);
    if (reason === 'cancel') h.store.run('UPDATE incidents SET cancelRequested=1 WHERE id=?', id);
    else h.jump(61000);
    await h.worker.advance(id);
    expect(h.store.incident(id).outcome).toBe(reason === 'cancel' ? 'cancelled' : 'failed');
    expect(h.writes).toBe(0);
    h.store.close();
  });
  it('healthy primary never changes routing', async () => {
    const h = harness();
    await h.worker.tick();
    h.jump(3000);
    await h.worker.tick();
    expect(h.writes).toBe(0);
    expect(h.store.incidents()).toHaveLength(0);
    h.store.close();
  });
  it('one transient failed probe does not trigger failover', async () => {
    const h = harness();
    h.health.primary = false;
    await h.worker.tick();
    h.health.primary = true;
    h.jump(3000);
    await h.worker.tick();
    expect(h.store.incidents()).toHaveLength(0);
    expect(h.writes).toBe(0);
    h.store.close();
  });
  it('skips start for an already-running backup and measures verified recovery', async () => {
    const h = harness();
    const id = h.incident();
    await h.advance(id);
    expect(h.starts).toBe(0);
    expect(h.writes).toBe(1);
    expect(h.store.incident(id).outcome).toBe('recovered');
    expect(h.store.incident(id).objectiveMet).toBe(true);
    h.store.close();
  });
  it.each(['backup', 'dependency'] as const)('never switches traffic when %s is unready', async (key) => {
    const h = harness();
    h.health[key] = false;
    const id = h.incident();
    await h.advance(id, 20);
    expect(h.writes).toBe(0);
    expect(h.store.incident(id).outcome).toBe('failed');
    h.store.close();
  });
  it('replays an idempotency key and rejects conflicting incidents', () => {
    const h = harness();
    const key = 'persisted-key';
    const id = h.worker.create(h.app.id, 'backup', 'worker', key, 1, 'single-vantage');
    expect(h.worker.create(h.app.id, 'backup', 'worker', key, 1, 'single-vantage')).toBe(id);
    expect(() => h.incident()).toThrow('operation');
    expect(() => h.worker.create(h.app.id, 'primary', 'worker', key, 1, 'single-vantage')).toThrow(
      'Idempotency',
    );
    h.store.close();
  });
  it('crash after accepted provider start inspects running state rather than repeating start', async () => {
    const h = harness();
    h.health.running = false;
    h.health.crashStart = true;
    const id = h.incident();
    await h.advance(id, 2);
    expect(h.starts).toBe(1);
    h.jump(31000);
    const resumed = new Orchestrator(h.store, h.runtime, () => h.now);
    await resumed.advance(id);
    expect(h.starts).toBe(1);
    expect(h.store.incident(id).phase).toBe('Validate');
    h.store.close();
  });
  it('crash after route acceptance reads the resulting route and does not duplicate writes', async () => {
    const h = harness();
    h.health.crashRoute = true;
    const id = h.incident();
    await h.advance(id, 5);
    expect(h.writes).toBe(1);
    h.jump(31000);
    const resumed = new Orchestrator(h.store, h.runtime, () => h.now);
    await resumed.advance(id);
    await resumed.advance(id);
    expect(h.writes).toBe(1);
    expect(h.store.incident(id).outcome).toBe('recovered');
    h.store.close();
  });
  it('retains deadline and generation, and fences old local actors', async () => {
    const h = harness();
    const id = h.incident();
    const deadline = h.store.incident(id).deadlineAt;
    const gen = h.store.one('SELECT generation FROM operation_leases WHERE applicationId=?', h.app.id)!
      .generation as number;
    h.jump(31000);
    const resumed = new Orchestrator(h.store, h.runtime, () => h.now);
    resumed.acquire(h.app.id);
    expect(() => h.worker.fence(h.app.id, gen, 1)).toThrow('stale');
    expect(h.store.incident(id).deadlineAt).toBe(deadline);
    h.jump(31000);
    await resumed.advance(id);
    expect(h.store.incident(id).outcome).toBe('failed');
    expect(h.writes).toBe(0);
    h.store.close();
  });
  it('unexpected external route edit requires reconciliation', async () => {
    const h = harness();
    const id = h.incident();
    await h.advance(id, 4);
    h.edit(h.records.map((r) => ({ ...r, content: '1.1.1.1' })));
    await h.advance(id, 3);
    expect(h.store.incident(id).outcome).toBe('reconciliation_required');
    expect(h.writes).toBe(0);
    h.store.close();
  });
  it('partial A/AAAA change is reported honestly', async () => {
    const h = harness();
    const a = h.store.application(h.app.id);
    const v6 = {
      id: 'record-aaaa',
      type: 'AAAA' as const,
      name: a.publicHostname,
      content: '2606:4700:4700::1111',
      proxied: true,
      ttl: 1,
    };
    a.routing!.snapshot.push(v6);
    const backup = a.origins.find((o) => o.role === 'backup')!;
    backup.ipv6 = '2606:4700:4700::1001';
    h.store.run('UPDATE origins SET config=? WHERE id=?', JSON.stringify(backup), backup.id);
    h.store.run('UPDATE routing_configs SET config=? WHERE applicationId=?', JSON.stringify(a.routing), a.id);
    h.edit(a.routing!.snapshot);
    h.health.partial = true;
    const id = h.incident();
    await h.advance(id);
    expect(h.store.incident(id).outcome).toBe('reconciliation_required');
    expect(h.store.application(a.id).activeOriginId).not.toBe(backup.id);
    h.store.close();
  });
  it('recovered primary never silently fails back', async () => {
    const h = harness();
    const id = h.incident();
    await h.advance(id);
    const active = h.store.application(h.app.id).activeOriginId;
    h.jump(3000);
    await h.worker.tick();
    expect(h.store.application(h.app.id).activeOriginId).toBe(active);
    expect(h.writes).toBe(1);
    h.store.close();
  });
  it('wrong public identity never marks backup active', async () => {
    const h = harness();
    h.health.publicIdentity = false;
    const id = h.incident();
    await h.advance(id, 26);
    expect(h.store.incident(id).outcome).toBe('reconciliation_required');
    expect(h.store.application(h.app.id).activeOriginId).toBe(h.app.activeOriginId);
    h.store.close();
  });
  it('dry run leaves all provider and router write counters at zero', async () => {
    const h = harness();
    h.health.running = false;
    const plan = await h.worker.plan(h.app.id, 'backup');
    expect(plan.startResource).toBe(true);
    expect(h.starts).toBe(0);
    expect(h.writes).toBe(0);
    h.store.close();
  });
  it('cancel before routing leaves route intact; cancel after intent needs reconciliation', async () => {
    const h = harness();
    const id = h.incident();
    await h.advance(id, 2);
    h.store.run('UPDATE incidents SET cancelRequested=1 WHERE id=?', id);
    await h.advance(id, 1);
    expect(h.store.incident(id).outcome).toBe('cancelled');
    expect(h.writes).toBe(0);
    const second = h.incident();
    await h.advance(second, 5);
    h.store.run('UPDATE incidents SET cancelRequested=1 WHERE id=?', second);
    await h.advance(second, 1);
    expect(h.store.incident(second).outcome).toBe('reconciliation_required');
    h.store.close();
  });
});
