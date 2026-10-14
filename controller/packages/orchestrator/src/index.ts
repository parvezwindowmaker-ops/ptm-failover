import { createHash, randomUUID } from 'node:crypto';
import type { Application, Origin, Probe, ServerProvider, TrafficRouter } from '@ptm/contracts';
import { Fault } from '../../contracts/src/fault.ts';
import { routesEqual, targetRecords } from '../../routing/src/plan.ts';
import { ProviderHttpError } from '../../providers/src/http.ts';
import type { Store } from '../../../apps/api/src/db.js';

export type Runtime = {
  provider(app: Application, origin: Origin): ServerProvider;
  router(app: Application): TrafficRouter;
  probe(app: Application, origin: Origin, publicRoute?: boolean): Promise<Probe>;
};
const states: Record<string, string> = {
  Observe: 'CONFIRMING_FAILURE',
  'Prepare Backup': 'PREPARING_BACKUP',
  Validate: 'WAITING_BACKUP_READY',
  'Switch Traffic': 'SWITCHING_TRAFFIC',
  Verify: 'VERIFYING_TRAFFIC',
};
export class Orchestrator {
  owner = randomUUID();
  heartbeat: number | null = null;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastRetention = 0;
  constructor(
    public store: Store,
    public runtime: Runtime,
    public now = () => Date.now(),
  ) {}
  start() {
    this.store.guard(this.owner, this.now());
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.heartbeat = null;
      });
    }, 1000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 50));
    this.store.run('DELETE FROM controller_guard WHERE ownerId=?', this.owner);
    this.store.run('UPDATE operation_leases SET expiresAt=0 WHERE ownerId=?', this.owner);
  }
  async plan(id: string, targetRole: 'primary' | 'backup') {
    const app = this.store.application(id);
    const target = app.origins.find((o) => o.role === targetRole);
    if (!target || !app.routing || app.origins.length !== 2)
      throw new Fault('INCOMPLETE_CONFIGURATION', 'Configure both origins and approved routing first');
    if (!target.expectedIdentity)
      throw new Fault(
        'IDENTITY_REQUIRED',
        'Traffic changes require an expected readiness identity on the target',
      );
    const power = await this.runtime.provider(app, target).inspectResource(target.resourceId || target.id);
    const records = await this.runtime.router(app).planSwitch(target, app.routing.snapshot);
    const readiness = await this.runtime.probe(app, target);
    const changes = {
      applicationId: app.id,
      revision: app.configurationRevision,
      targetOriginId: target.id,
      startResource: target.startOnFailure && power.power === 'stopped',
      records,
      scope: app.demo ? 'Local demo fixtures only' : 'Selected DNS records and one controller vantage point',
      readiness,
    };
    const planHash = createHash('sha256')
      .update(JSON.stringify({ ...changes, readiness: undefined }))
      .digest('hex');
    return { ...changes, planHash };
  }
  create(
    id: string,
    role: 'primary' | 'backup',
    actor: string,
    key: string,
    revision: number,
    trigger = 'manual',
    planHash?: string,
    expectedPlanHash?: string,
  ) {
    const requestHash = createHash('sha256')
      .update(JSON.stringify([id, role, actor, revision, planHash]))
      .digest('hex');
    return this.store.tx(() => {
      const prior = this.store.one('SELECT * FROM idempotency_keys WHERE key=?', key);
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new Fault('IDEMPOTENCY_CONFLICT', 'Idempotency key was used for a different request', 409);
        return prior.operationId as string;
      }
      const app = this.store.assertEditable(id, revision);
      const target = app.origins.find((o) => o.role === role);
      if (app.operationalState === 'RECONCILIATION_REQUIRED')
        throw new Fault(
          'RECONCILIATION_REQUIRED',
          'Reconcile the observed public route before requesting another traffic change',
          409,
        );
      if (!target || !app.routing)
        throw new Fault('INCOMPLETE_CONFIGURATION', 'Origins and routing must be configured');
      if (target.id === app.activeOriginId)
        throw new Fault('ALREADY_ACTIVE', 'Target origin is already active', 409);
      if (trigger === 'manual' && (!planHash || planHash !== expectedPlanHash))
        throw new Fault('PLAN_CHANGED', 'Review a fresh action plan before changing traffic', 409);
      if (
        role === 'primary' &&
        (!target.observation?.success ||
          this.now() - target.observation.at > app.policy.intervalSeconds * 2000 ||
          !target.healthySince ||
          this.now() - target.healthySince < app.policy.failbackHealthySeconds * 1000)
      )
        throw new Fault(
          'FAILBACK_NOT_READY',
          'Primary must be continuously ready throughout the configured failback window',
          409,
        );
      const latest = this.store.one(
        'SELECT completedAt FROM incidents WHERE applicationId=? AND completedAt IS NOT NULL ORDER BY completedAt DESC LIMIT 1',
        id,
      );
      if (latest && this.now() - Number(latest.completedAt) < app.policy.cooldownSeconds * 1000)
        throw new Fault('COOLDOWN', 'Incident cooldown is still active', 409);
      const incidentId = randomUUID();
      const began = this.now();
      this.store.run(
        'INSERT INTO incidents(id,applicationId,trigger,actor,phase,targetOriginId,previousOriginId,startedAt,deadlineAt,bootDeadlineAt,correlationId,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        incidentId,
        id,
        trigger,
        actor,
        'Observe',
        target.id,
        app.activeOriginId,
        began,
        began + app.policy.objectiveSeconds * 1000,
        began + app.policy.bootDeadlineSeconds * 1000,
        randomUUID(),
        JSON.stringify(app),
      );
      this.store.run('INSERT INTO idempotency_keys VALUES(?,?,?,?)', key, requestHash, incidentId, began);
      this.store.audit(actor, role === 'primary' ? 'failback.requested' : 'failover.requested', id, {
        incidentId,
        target: target.id,
        revision,
      });
      this.acquire(id);
      this.store.run(
        'UPDATE applications SET operationalState=? WHERE id=?',
        role === 'primary' ? 'FAILBACK_IN_PROGRESS' : 'CONFIRMING_FAILURE',
        id,
      );
      return incidentId;
    });
  }
  acquire(id: string) {
    const now = this.now();
    return this.store.tx(() => {
      const lease = this.store.one('SELECT * FROM operation_leases WHERE applicationId=?', id);
      if (lease && lease.ownerId !== this.owner && Number(lease.expiresAt) > now)
        throw new Fault('LEASE_BUSY', 'Another worker still owns this operation', 409, true);
      const gen = Number(lease?.generation ?? 0) + (lease?.ownerId === this.owner ? 0 : 1);
      this.store.run(
        'INSERT INTO operation_leases VALUES(?,?,?,?) ON CONFLICT(applicationId) DO UPDATE SET ownerId=excluded.ownerId,generation=excluded.generation,expiresAt=excluded.expiresAt',
        id,
        this.owner,
        gen,
        now + 30000,
      );
      return gen;
    });
  }
  fence(id: string, generation: number, revision: number) {
    const lease = this.store.one('SELECT * FROM operation_leases WHERE applicationId=?', id);
    const guard = this.store.one('SELECT * FROM controller_guard WHERE id=1');
    if (
      !lease ||
      lease.ownerId !== this.owner ||
      lease.generation !== generation ||
      Number(lease.expiresAt) <= this.now() ||
      (guard && (guard.ownerId !== this.owner || Number(guard.expiresAt) <= this.now())) ||
      this.store.application(id).configurationRevision !== revision
    )
      throw new Fault('STALE_WORKER', 'Worker lease or configuration revision is stale', 409);
    const incident = this.store.one(
      'SELECT cancelRequested,deadlineAt FROM incidents WHERE applicationId=? AND outcome IS NULL',
      id,
    );
    if (!incident || incident.cancelRequested || Number(incident.deadlineAt) <= this.now())
      throw new Fault('OPERATION_STOPPED', 'Operation was cancelled or deadline expired', 409);
    this.store.run(
      'UPDATE operation_leases SET expiresAt=? WHERE applicationId=? AND ownerId=? AND generation=?',
      this.now() + 30000,
      id,
      this.owner,
      generation,
    );
  }
  private phase(id: string, phase: string) {
    const incident = this.store.incident(id);
    this.store.tx(() => {
      this.store.run('UPDATE incidents SET phase=?,attempts=0,nextAttemptAt=0 WHERE id=?', phase, id);
      this.store.run(
        'UPDATE applications SET operationalState=? WHERE id=?',
        states[phase],
        incident.applicationId,
      );
    });
  }
  private step(id: string, phase: string, action: string, intent: unknown) {
    const seq = this.store.steps(id).length + 1;
    return Number(
      this.store.run(
        'INSERT INTO incident_steps(incidentId,sequence,phase,action,intent,startedAt,result) VALUES(?,?,?,?,?,?,?)',
        id,
        seq,
        phase,
        action,
        JSON.stringify(intent),
        this.now(),
        'intent persisted',
      ).lastInsertRowid,
    );
  }
  private done(id: number, result: string) {
    this.store.run('UPDATE incident_steps SET result=?,completedAt=? WHERE id=?', result, this.now(), id);
  }
  private finish(id: string, outcome: string, error: string | null = null) {
    const i = this.store.incident(id);
    const snapshot = JSON.parse(i.snapshot) as Application;
    this.store.tx(() => {
      const met = outcome === 'recovered' && this.now() <= i.deadlineAt;
      this.store.run(
        'UPDATE incidents SET outcome=?,completedAt=?,objectiveMet=?,error=?,phase=? WHERE id=?',
        outcome,
        this.now(),
        outcome === 'recovered' ? Number(met) : null,
        error,
        outcome === 'recovered' ? 'Complete' : i.phase,
        id,
      );
      const state =
        outcome === 'recovered'
          ? snapshot.origins.find((o) => o.id === i.targetOriginId)?.role === 'backup'
            ? 'ACTIVE_BACKUP'
            : 'HEALTHY_PRIMARY'
          : outcome === 'reconciliation_required'
            ? 'RECONCILIATION_REQUIRED'
            : outcome === 'cancelled'
              ? 'PAUSED'
              : 'FAILED';
      this.store.run(
        'UPDATE applications SET operationalState=?,activeOriginId=CASE WHEN ? THEN ? ELSE activeOriginId END WHERE id=?',
        state,
        Number(outcome === 'recovered'),
        i.targetOriginId,
        i.applicationId,
      );
      this.store.run(
        'UPDATE operation_leases SET expiresAt=0 WHERE applicationId=? AND ownerId=?',
        i.applicationId,
        this.owner,
      );
      this.store.audit(
        i.actor,
        'incident.' + outcome,
        i.applicationId,
        { incidentId: id, error },
        i.correlationId,
      );
      const webhook = this.store.get<{ url: string } | null>('webhook', null);
      if (webhook && !snapshot.demo)
        this.store.run(
          'INSERT INTO notification_outbox(id,event,destination,payload,nextAttemptAt) VALUES(?,?,?,?,?)',
          randomUUID(),
          outcome,
          webhook.url,
          JSON.stringify({
            incidentId: id,
            application: snapshot.name,
            outcome,
            durationMs: this.now() - i.startedAt,
            objectiveMet: met,
          }),
          this.now(),
        );
    });
  }
  async advance(id: string) {
    const i = this.store.incident(id);
    if (i.outcome || (i.nextAttemptAt > this.now() && !i.cancelRequested && this.now() < i.deadlineAt))
      return;
    let generation: number;
    try {
      generation = this.acquire(i.applicationId);
    } catch {
      return;
    }
    const app = JSON.parse(i.snapshot) as Application;
    const target = app.origins.find((o) => o.id === i.targetOriginId)!;
    const routingIntent = this.store.steps(id).find((s) => s.phase === 'Switch Traffic');
    if (i.cancelRequested || this.now() >= i.deadlineAt) {
      this.finish(
        id,
        routingIntent ? 'reconciliation_required' : i.cancelRequested ? 'cancelled' : 'failed',
        i.cancelRequested
          ? 'Operator cancelled; route is unchanged or needs review.'
          : 'Absolute recovery deadline expired.',
      );
      return;
    }
    const fence = () => this.fence(app.id, generation, app.configurationRevision);
    try {
      fence();
      const provider = this.runtime.provider(app, target);
      const router = this.runtime.router(app);
      if (i.phase === 'Observe') {
        const step = this.step(id, 'Observe', 'Snapshot approved configuration and confirmation', {
          trigger: i.trigger,
          revision: app.configurationRevision,
        });
        this.done(
          step,
          i.trigger === 'manual'
            ? 'Operator confirmed the reviewed plan'
            : 'Explicitly opted-in single-vantage confirmation; provider-wide outage is unproven',
        );
        this.phase(id, 'Prepare Backup');
      } else if (i.phase === 'Prepare Backup') {
        const resource = await provider.inspectResource(target.resourceId || target.id);
        fence();
        this.store.run('UPDATE origins SET power=? WHERE id=?', resource.power, target.id);
        if (resource.power === 'running' || !target.startOnFailure) {
          this.phase(id, 'Validate');
          return;
        }
        if (this.now() >= i.bootDeadlineAt) {
          this.finish(id, 'failed', 'Backup boot deadline expired; no route change.');
          return;
        }
        const previous = this.store.steps(id).find((s) => s.phase === 'Prepare Backup');
        if (!previous && resource.power === 'stopped') {
          if (!provider.capabilities().start)
            throw new Fault('UNAVAILABLE_CAPABILITY', 'Provider cannot start this origin');
          const step = this.step(id, 'Prepare Backup', 'Start existing stopped resource', {
            resourceId: target.resourceId || target.id,
          });
          fence();
          try {
            const receipt = await provider.startResource(target.resourceId || target.id);
            fence();
            this.done(
              step,
              `Start accepted; power/readiness still unverified. Request ID: ${receipt.requestId ?? 'unknown'}`,
            );
          } catch (error) {
            this.store.run(
              'UPDATE incident_steps SET result=? WHERE id=?',
              'Start outcome unknown; inspect state before any repeat',
              step,
            );
            throw error;
          }
        }
      } else if (i.phase === 'Validate') {
        if (this.now() >= i.bootDeadlineAt) {
          this.finish(id, 'failed', 'Backup readiness deadline expired; no route change.');
          return;
        }
        const observation = await this.runtime.probe(app, target);
        fence();
        this.store.recordProbe(
          this.store.origins(app.id).find((o) => o.id === target.id)!,
          observation,
        );
        const count = observation.success ? i.readinessCount + 1 : 0;
        this.store.run(
          'UPDATE incidents SET readinessCount=?,nextAttemptAt=? WHERE id=?',
          count,
          this.now() + app.policy.intervalSeconds * 1000,
          id,
        );
        const step = this.step(id, 'Validate', 'Probe direct origin, identity, release and dependencies', {
          origin: target.id,
        });
        this.done(step, observation.success ? 'Ready' : (observation.reason ?? 'Unknown'));
        if (count >= app.policy.readinessSuccesses) this.phase(id, 'Switch Traffic');
      } else if (i.phase === 'Switch Traffic') {
        const wanted = targetRecords(target, app.routing!.snapshot);
        const current = await router.readRoute();
        fence();
        if (routingIntent) {
          if (routesEqual(current, wanted)) {
            this.done(routingIntent.id, 'Desired route read back after persisted intent');
            this.phase(id, 'Verify');
            return;
          }
          if (!routesEqual(current, app.routing!.snapshot, true)) {
            this.finish(
              id,
              'reconciliation_required',
              'Partial routing update or external record edit. Observed route requires operator review.',
            );
            return;
          }
          // An accepted/timeout write may still complete. Never blindly repeat a persisted intent.
          this.store.run('UPDATE incidents SET nextAttemptAt=? WHERE id=?', this.now() + 5000, id);
          return;
        }
        const fresh = await this.runtime.probe(app, target);
        fence();
        if (!fresh.success)
          throw new Fault('TARGET_NOT_READY', 'Target lost readiness before routing; route unchanged');
        const plan = await router.planSwitch(target, app.routing!.snapshot);
        fence();
        const step = this.step(id, 'Switch Traffic', 'Patch only approved existing record contents', {
          before: current,
          desired: plan,
        });
        await router.applySwitch(plan, fence);
        fence();
        if (!(await router.inspectConvergence(plan))) {
          this.finish(
            id,
            'reconciliation_required',
            'Record readback did not match the entire intended A/AAAA set',
          );
          return;
        }
        fence();
        this.done(step, 'Entire approved record set read back successfully');
        this.phase(id, 'Verify');
      } else if (i.phase === 'Verify') {
        const desired = targetRecords(target, app.routing!.snapshot);
        const current = await router.readRoute();
        fence();
        if (!routesEqual(current, desired)) {
          this.finish(id, 'reconciliation_required', 'Managed route changed before verification');
          return;
        }
        const observed = await this.runtime.probe(app, target, true);
        fence();
        const step = this.step(id, 'Verify', 'Public hostname cache-bypass readiness and identity check', {
          scope: 'One controller vantage; global convergence is not proven',
        });
        this.done(
          step,
          observed.success
            ? 'Public route returned expected identity and release'
            : (observed.reason ?? 'Unknown'),
        );
        if (!observed.success) {
          this.store.run(
            'UPDATE incidents SET nextAttemptAt=? WHERE id=?',
            this.now() + app.policy.intervalSeconds * 1000,
            id,
          );
          return;
        }
        this.store.tx(() => {
          const routing = { ...app.routing!, snapshot: current, revision: app.routing!.revision + 1 };
          this.store.run(
            'UPDATE routing_configs SET config=? WHERE applicationId=?',
            JSON.stringify(routing),
            app.id,
          );
          this.finish(id, 'recovered');
        });
      }
    } catch (error) {
      if (error instanceof Fault && error.code === 'STALE_WORKER') return;
      const message =
        error instanceof Fault
          ? `${error.code}: ${error.message}`
          : 'Provider request failed; sensitive details withheld';
      if (
        error instanceof Fault &&
        ['RECONCILIATION_REQUIRED', 'AMBIGUOUS_ROUTES', 'PROXY_MISMATCH'].includes(error.code)
      ) {
        this.finish(id, 'reconciliation_required', message);
        return;
      }
      const attempt = i.attempts + 1;
      if (attempt >= 5 && !routingIntent && i.phase !== 'Switch Traffic') {
        this.finish(id, 'failed', message);
        return;
      }
      const delay = Math.max(
        error instanceof ProviderHttpError ? error.retryAfterMs : 0,
        Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 500),
      );
      this.store.run(
        'UPDATE incidents SET attempts=?,error=?,nextAttemptAt=? WHERE id=?',
        attempt,
        message,
        this.now() + delay,
        id,
      );
    }
  }
  async check(app: Application) {
    for (const origin of app.origins) {
      const p = await this.runtime.probe(app, origin);
      this.store.recordProbe(origin, p);
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.store.guard(this.owner, this.now());
      this.heartbeat = this.now();
      for (const r of this.store.all(
        'SELECT id FROM incidents WHERE outcome IS NULL ORDER BY startedAt LIMIT 100',
      ))
        await this.advance(r.id as string);
      for (const app of this.store.applications()) {
        const primary = app.origins.find((o) => o.role === 'primary');
        if (!primary) continue;
        if (!primary.observation || this.now() - primary.observation.at >= app.policy.intervalSeconds * 1000)
          await this.check(app);
        if (
          this.store.one('SELECT id FROM incidents WHERE applicationId=? AND outcome IS NULL', app.id) ||
          app.activeOriginId !== primary.id ||
          app.operationalState === 'RECONCILIATION_REQUIRED'
        )
          continue;
        const recent = this.store.all<{ success: number }>(
          'SELECT success FROM probe_results WHERE originId=? ORDER BY id DESC LIMIT ?',
          primary.id,
          app.policy.failureThreshold,
        );
        const failures = recent.length >= app.policy.failureThreshold && recent.every((p) => !p.success);
        const state = recent[0]?.success
          ? 'HEALTHY_PRIMARY'
          : failures
            ? 'CONFIRMING_FAILURE'
            : 'SUSPECT_PRIMARY';
        if (!app.automationEnabled || app.policy.maintenance) {
          this.store.run('UPDATE applications SET operationalState=? WHERE id=?', 'PAUSED', app.id);
          continue;
        }
        this.store.run('UPDATE applications SET operationalState=? WHERE id=?', state, app.id);
        const fresh = this.store.application(app.id);
        const sharedFailure = fresh.origins.some((o) =>
          o.observation?.reason?.startsWith('SHARED_DEPENDENCY_FAILED'),
        );
        if (failures && !sharedFailure && app.policy.confirmation === 'single-vantage') {
          try {
            this.create(
              app.id,
              'backup',
              'worker',
              `automatic:${app.id}:${fresh.origins.find((o) => o.role === 'primary')?.observation?.at}`,
              app.configurationRevision,
              'single-vantage',
            );
          } catch (error) {
            if (!(error instanceof Fault)) throw error;
          }
        }
      }
      if (this.now() - this.lastRetention > 3600000) {
        this.store.retention(this.now());
        this.lastRetention = this.now();
      }
    } finally {
      this.busy = false;
    }
  }
}
