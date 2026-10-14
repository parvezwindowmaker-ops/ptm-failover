import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Cloud,
  Globe2,
  Info,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  type Application,
  type Overview,
  type Origin,
  type Incident,
  type Step,
  type ProviderView,
  type Policy,
  type ControllerStatus,
  type RecordSnapshot,
} from '@ptm/contracts';
import { request, queryClient, time, date, label } from './lib';
import { Badge, Button, Dialog, Empty } from './components/ui';
import { SshSettings } from './components/SshSettings';

export function useAction() {
  const mutation = useMutation({
    mutationFn: ({
      path,
      data,
      method,
      key,
    }: {
      path: string;
      data?: unknown;
      method?: string;
      key?: string;
    }) => request(path, data, method, key),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return {
    ...mutation,
    run: (path: string, data?: unknown, method?: string, key?: string) =>
      mutation.mutateAsync({ path, data, method, key }),
  };
}
export function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return action.isError ? (
    <div role="alert" className="notice notice-error">
      {action.error.message}
    </div>
  ) : action.isSuccess ? (
    <div role="status" className="notice notice-success">
      Changes saved.
    </div>
  ) : null;
}
export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Readiness({ origin }: { origin?: Origin }) {
  const stale = origin?.observation && Date.now() - origin.observation.at > 60000;
  return (
    <Badge
      tone={
        stale ? 'amber' : origin?.observation ? (origin.observation.success ? 'green' : 'red') : 'neutral'
      }
    >
      {stale ? 'Stale' : origin?.observation ? (origin.observation.success ? 'Ready' : 'Unready') : 'Unknown'}
    </Badge>
  );
}
export function ApplicationTable({ apps, onAdd }: { apps: Application[]; onAdd?: () => void }) {
  return apps.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Application</th>
            <th>Active origin</th>
            <th>Primary</th>
            <th>Backup</th>
            <th>Automation</th>
            <th>Last probe</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <tr key={a.id}>
              <td>
                <Link className="app-name" to={`/applications/${a.id}`}>
                  <span className="app-icon">
                    <Globe2 size={18} />
                  </span>
                  <span>
                    <strong>{a.name}</strong>
                    <small>{a.publicHostname}</small>
                  </span>
                </Link>
              </td>
              <td>
                <span className="origin-label">
                  <Server size={14} />
                  {a.operationalState === 'RECONCILIATION_REQUIRED'
                    ? 'Unknown · review required'
                    : (a.origins.find((o) => o.id === a.activeOriginId)?.role ?? 'Unknown')}
                </span>
              </td>
              <td>
                <Readiness origin={a.origins.find((o) => o.role === 'primary')} />
              </td>
              <td>
                <Readiness origin={a.origins.find((o) => o.role === 'backup')} />
              </td>
              <td>
                <Badge tone={a.automationEnabled ? 'blue' : 'neutral'}>
                  {a.automationEnabled
                    ? a.policy.confirmation === 'operator'
                      ? 'Operator review'
                      : 'Automatic'
                    : 'Paused'}
                </Badge>
              </td>
              <td className="muted mono">{time(a.origins[0]?.observation?.at)}</td>
              <td>
                <Link className="icon-link" aria-label={`Open ${a.name}`} to={`/applications/${a.id}`}>
                  <ChevronRight size={18} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="Your first application starts here"
      description="Connect a primary origin, prepare a backup and review your recovery policy."
      action={
        onAdd && (
          <Button onClick={onAdd}>
            <Plus size={16} />
            Add Application
          </Button>
        )
      }
    />
  );
}
export function Latency({ app }: { app?: Application }) {
  const probes = useQuery({
    queryKey: ['probes', app?.id],
    queryFn: () =>
      request<{ originId: string; at: number; latency: number; success: number }[]>(
        `/applications/${app!.id}/probes`,
      ),
    enabled: !!app,
  });
  const primaryId = app?.origins.find((o) => o.role === 'primary')?.id;
  const points = probes.data
    ?.filter((p) => p.originId === primaryId)
    .map((p) => ({ at: p.at, latency: p.latency, success: p.success }));
  return (
    <section className="card chart-card">
      <div className="card-heading">
        <div>
          <h2>Origin response time</h2>
          <p>Measured primary readiness probes</p>
        </div>
        <Badge>Last hour</Badge>
      </div>
      {points?.length ? (
        <div
          className="chart"
          role="img"
          aria-label={`Primary response latency. ${points.length} measured samples.`}
        >
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={points}>
              <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--border)" />
              <XAxis
                dataKey="at"
                tickFormatter={(v) => time(v).slice(0, 5)}
                minTickGap={50}
                axisLine={false}
                tickLine={false}
                fontSize={11}
              />
              <YAxis unit="ms" axisLine={false} tickLine={false} fontSize={11} width={55} />
              <Tooltip
                labelFormatter={(v) => date(Number(v))}
                formatter={(value) => [`${Number(value).toFixed(0)} ms`, 'Latency']}
                contentStyle={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              />
              <Line
                type="monotone"
                dataKey="latency"
                stroke="#2563eb"
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty
          title="Waiting for measured probes"
          description="The worker collects latency even when the dashboard is closed."
        />
      )}
    </section>
  );
}
export function RouteDiagram({ app }: { app?: Application }) {
  const primary = app?.origins.find((o) => o.role === 'primary');
  const backup = app?.origins.find((o) => o.role === 'backup');
  return (
    <section className="card topology">
      <div className="card-heading">
        <div>
          <h2>Recovery topology</h2>
          <p>{app?.name ?? 'Application routing relationships'}</p>
        </div>
        <span className="subtle-icon">
          <Globe2 size={18} />
        </span>
      </div>
      <div className="route-diagram">
        {[primary, null, backup].map((o, i) => (
          <div className="route-part" key={i}>
            {i === 1 ? (
              <>
                <span className="route-symbol route-public">
                  <Globe2 size={22} />
                </span>
                <strong>{app?.publicHostname ?? 'Public hostname'}</strong>
                <small>Hostname stays the same</small>
              </>
            ) : (
              <>
                <span
                  className={`route-symbol ${app?.operationalState !== 'RECONCILIATION_REQUIRED' && app?.activeOriginId === o?.id ? 'route-active' : ''}`}
                >
                  <Server size={23} />
                </span>
                <strong>{i === 0 ? 'Primary origin' : 'Backup origin'}</strong>
                <small>{o?.address ?? 'Not configured'}</small>
                <Readiness origin={o ?? undefined} />
                {o && app?.operationalState !== 'RECONCILIATION_REQUIRED' && app?.activeOriginId === o.id && (
                  <span className="active-caption">Receiving traffic</span>
                )}
              </>
            )}
            {i !== 2 && <ArrowRight className="route-arrow" size={20} />}
          </div>
        ))}
      </div>
      <div className="card-note">
        <Info size={14} />
        Routing switches requests. Your databases and files need their own availability design.
      </div>
    </section>
  );
}
export function IncidentList({ incidents }: { incidents: Incident[] }) {
  return incidents.length ? (
    <div className="incident-list">
      {incidents.map((i) => (
        <Link to={`/incidents?selected=${i.id}`} key={i.id} className="incident-item">
          <span className={`incident-symbol ${i.outcome === 'recovered' ? 'recovered' : ''}`}>
            {i.outcome === 'recovered' ? <Check size={17} /> : <TriangleAlert size={17} />}
          </span>
          <div>
            <strong>{i.outcome ? label(i.outcome) : i.phase}</strong>
            <small>
              {date(i.startedAt)} · {i.trigger}
            </small>
          </div>
          <span className="incident-duration">
            {i.completedAt ? `${((i.completedAt - i.startedAt) / 1000).toFixed(1)}s` : 'In progress'}
            <ChevronRight size={15} />
          </span>
        </Link>
      ))}
    </div>
  ) : (
    <Empty
      title="No incidents yet"
      description="Every recovery will leave a clear, timestamped record here."
    />
  );
}
export function OverviewPage({ onAdd }: { onAdd: () => void }) {
  const data = useQuery({ queryKey: ['overview'], queryFn: () => request<Overview>('/overview') });
  const ctrl = useQuery({
    queryKey: ['controller'],
    queryFn: () => request<ControllerStatus>('/controller/status'),
  });
  const [selected, setSelected] = useState('');
  if (data.isPending) return <p className="notice">Loading applications and measurements…</p>;
  if (data.isError)
    return (
      <p role="alert" className="notice notice-error">
        {data.error.message}
      </p>
    );
  const overview = data.data;
  const app = overview.applications.find((a) => a.id === selected) ?? overview.applications[0];
  return (
    <>
      <Heading
        eyebrow="CONTROL CENTER"
        title="Overview"
        description="A clear view of your applications. A prepared path to recovery."
        action={
          <Button onClick={onAdd}>
            <Plus size={17} />
            Add Application
          </Button>
        }
      />
      <div className="kpi-grid">
        {[
          {
            name: 'Applications monitored',
            value: overview.monitored,
            description: 'Configured origin pairs',
            icon: BoxesIcon,
          },
          {
            name: 'Unhealthy origins',
            value: overview.unhealthy,
            description: 'Latest measured readiness',
            icon: Activity,
          },
          {
            name: 'Open incidents',
            value: overview.openIncidents,
            description: 'Recovery operations in progress',
            icon: TriangleAlert,
          },
          {
            name: 'Last recovery',
            value:
              overview.lastRecoveryMs === null
                ? 'Unknown'
                : `${(overview.lastRecoveryMs / 1000).toFixed(1)}s`,
            description: 'Measured · 300s default objective',
            icon: Timer,
          },
        ].map((k) => (
          <section className="card kpi" key={k.name}>
            <div>
              <span>{k.name}</span>
              <k.icon size={18} />
            </div>
            <strong>{k.value}</strong>
            <small>{k.description}</small>
          </section>
        ))}
      </div>
      <section className="card applications-card">
        <div className="card-heading">
          <div>
            <h2>
              Applications <span className="count">{overview.applications.length}</span>
            </h2>
            <p>Direct origin readiness and current routing</p>
          </div>
          <Link className="text-link" to="/applications">
            View all
            <ArrowUpRight size={15} />
          </Link>
        </div>
        <ApplicationTable apps={overview.applications} onAdd={onAdd} />
      </section>
      {overview.applications.length > 1 && (
        <label className="inline-select">
          Selected application
          <select value={app?.id} onChange={(e) => setSelected(e.target.value)}>
            {overview.applications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="two-column">
        <Latency app={app} />
        <RouteDiagram app={app} />
      </div>
      <div className="two-column lower-grid">
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Recent incidents</h2>
              <p>The record behind each recovery</p>
            </div>
            <Link className="text-link" to="/incidents">
              History
              <ArrowUpRight size={15} />
            </Link>
          </div>
          <IncidentList incidents={overview.incidents} />
        </section>
        <section className="card controller-card">
          <div className="card-heading">
            <div>
              <h2>Controller status</h2>
              <p>Monitoring continues without a browser</p>
            </div>
            <ShieldCheck size={20} />
          </div>
          <dl>
            <div>
              <dt>Worker</dt>
              <dd>
                <Badge tone={ctrl.data?.healthy ? 'green' : 'amber'}>
                  {ctrl.data?.healthy ? 'Running' : 'Unknown'}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Last heartbeat</dt>
              <dd className="mono">{time(ctrl.data?.heartbeat)}</dd>
            </div>
            <div>
              <dt>Installation location</dt>
              <dd>{ctrl.data?.location ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt>Deployment</dt>
              <dd>Single controller replica</dd>
            </div>
          </dl>
          <div className="card-note">
            <Info size={15} />
            Existing traffic routing continues if the controller is unavailable. New controller-directed
            failovers do not.
          </div>
        </section>
      </div>
    </>
  );
}
function BoxesIcon({ size }: { size: number }) {
  return <Server size={size} />;
}
export function ApplicationsPage({ onAdd }: { onAdd: () => void }) {
  const apps = useQuery({
    queryKey: ['applications'],
    queryFn: () => request<Application[]>('/applications'),
  });
  return (
    <>
      <Heading
        eyebrow="WORKSPACE"
        title="Applications"
        description="One primary, one backup, one unchanged public hostname."
        action={
          <Button onClick={onAdd}>
            <Plus size={17} />
            Add Application
          </Button>
        }
      />
      <section className="card">
        {apps.isError ? (
          <p role="alert" className="notice notice-error">
            {apps.error.message}
          </p>
        ) : apps.isPending ? (
          <p className="notice">Loading applications…</p>
        ) : (
          <ApplicationTable apps={apps.data} onAdd={onAdd} />
        )}
      </section>
    </>
  );
}
type Plan = {
  planHash: string;
  revision: number;
  targetOriginId: string;
  startResource: boolean;
  records: RecordSnapshot[];
  scope: string;
  readiness: { success: boolean; reason: string | null };
};
export function RecoveryActions({ app }: { app: Application }) {
  const action = useAction();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [direction, setDirection] = useState<'failover' | 'failback'>('failover');
  const [dry, setDry] = useState(false);
  async function review(d: 'failover' | 'failback', dryRun: boolean) {
    setDry(dryRun);
    setDirection(d);
    try {
      const p = (await action.run(`/applications/${app.id}/dry-run`, { direction: d })) as Plan;
      setPlan(p);
    } catch {
      /* Feedback renders the server error */
    }
  }
  async function execute() {
    if (!plan) return;
    try {
      await action.run(
        `/applications/${app.id}/${direction}`,
        { revision: plan.revision, planHash: plan.planHash },
        'POST',
        crypto.randomUUID(),
      );
      setPlan(null);
    } catch {
      /* Keep the review open */
    }
  }
  return (
    <>
      <div className="action-row">
        <Button
          variant="outline"
          disabled={action.isPending}
          onClick={() => void action.run(`/applications/${app.id}/check`, {}).catch(() => {})}
        >
          <RefreshCw size={15} />
          Check Now
        </Button>
        <Button
          variant="outline"
          disabled={action.isPending}
          onClick={() =>
            void action
              .run(`/applications/${app.id}/automation`, {
                enabled: !app.automationEnabled,
                revision: app.configurationRevision,
              })
              .catch(() => {})
          }
        >
          {app.automationEnabled ? 'Pause Automation' : 'Enable Automation'}
        </Button>
        <Button variant="outline" disabled={action.isPending} onClick={() => void review('failover', true)}>
          Dry Run
        </Button>
        <Button
          variant="destructive"
          disabled={action.isPending}
          onClick={() => void review('failover', false)}
        >
          Fail Over
        </Button>
        <Button variant="outline" disabled={action.isPending} onClick={() => void review('failback', false)}>
          Fail Back
        </Button>
      </div>
      <Feedback action={action} />
      <Dialog
        open={!!plan}
        onOpenChange={(open) => {
          if (!open) setPlan(null);
        }}
        title={
          dry ? 'Dry run · read-only plan' : `Review ${direction === 'failback' ? 'failback' : 'failover'}`
        }
        description={
          dry
            ? 'No provider or routing writes were performed.'
            : 'This action changes traffic. Review the exact target and record changes.'
        }
      >
        {plan && (
          <>
            <dl className="review-list">
              <div>
                <dt>Target</dt>
                <dd>{app.origins.find((o) => o.id === plan.targetOriginId)?.role}</dd>
              </div>
              <div>
                <dt>Provider action</dt>
                <dd>{plan.startResource ? 'Start existing stopped resource' : 'Skip resource start'}</dd>
              </div>
              <div>
                <dt>Direct readiness</dt>
                <dd>{plan.readiness.success ? 'Ready' : (plan.readiness.reason ?? 'Unknown')}</dd>
              </div>
              <div>
                <dt>Configuration revision</dt>
                <dd>{plan.revision}</dd>
              </div>
            </dl>
            <div className="record-plan">
              {plan.records.map((r) => (
                <div key={r.id}>
                  <Badge>{r.type}</Badge>
                  <strong>{r.name}</strong>
                  <ArrowRight size={15} />
                  <code>{r.content}</code>
                  <small>
                    {r.proxied
                      ? 'Proxied · provider TTL'
                      : `DNS only · ${r.ttl === 1 ? 'automatic TTL' : `TTL ${r.ttl}s`}`}
                  </small>
                </div>
              ))}
            </div>
            <p className="note">
              {plan.scope}. Automatic rollback is unavailable. No origin receives traffic until target
              readiness succeeds.
            </p>
            <Feedback action={action} />
            <div className="dialog-actions">
              <Button variant="outline" onClick={() => setPlan(null)}>
                Close
              </Button>
              {!dry && (
                <Button variant="destructive" disabled={action.isPending} onClick={() => void execute()}>
                  Confirm traffic change
                </Button>
              )}
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
export function ReconcileAction({ app }: { app: Application }) {
  const action = useAction();
  const [observed, setObserved] = useState<{
    records: RecordSnapshot[];
    routeHash: string;
    candidates: { id: string; role: string }[];
  } | null>(null);
  return (
    <>
      <Button
        variant="outline"
        onClick={() =>
          void action
            .run(`/applications/${app.id}/routing/observed`)
            .then((r) => setObserved(r as typeof observed))
            .catch(() => {})
        }
      >
        Inspect & reconcile route
      </Button>
      <Feedback action={action} />
      <Dialog
        open={!!observed}
        onOpenChange={(o) => {
          if (!o) setObserved(null);
        }}
        title="Review observed routing"
        description="Reconciliation reads and verifies existing traffic. It performs no DNS or provider writes."
      >
        {observed && (
          <>
            <div className="record-plan">
              {observed.records.map((r) => (
                <div key={r.id}>
                  <Badge>{r.type}</Badge>
                  <strong>{r.name}</strong>
                  <code>{r.content}</code>
                </div>
              ))}
            </div>
            <p className="note">
              Adoption requires matching every selected A/AAAA record, direct readiness and public identity.
              Automation will remain paused.
            </p>
            {!observed.candidates.length && (
              <div className="notice notice-error">
                Mixed or unknown routing. Resolve the external record contents to one prepared origin, then
                inspect again.
              </div>
            )}
            {observed.candidates.map((o) => (
              <Button
                key={o.id}
                disabled={action.isPending}
                onClick={() =>
                  void action
                    .run(`/applications/${app.id}/reconcile`, {
                      revision: app.configurationRevision,
                      originId: o.id,
                      routeHash: observed.routeHash,
                    })
                    .then(() => setObserved(null))
                    .catch(() => {})
                }
              >
                Verify & adopt {o.role} route
              </Button>
            ))}
            <Feedback action={action} />
          </>
        )}
      </Dialog>
    </>
  );
}
export function PolicyEditor({ app, onSaved }: { app: Application; onSaved?: () => void }) {
  const [policy, setPolicy] = useState<Policy>(app.policy);
  const action = useAction();
  const numbers: { key: keyof Policy; title: string; hint: string }[] = [
    {
      key: 'intervalSeconds',
      title: 'Probe interval (seconds)',
      hint: 'Direct origin observation frequency',
    },
    { key: 'timeoutSeconds', title: 'Request timeout (seconds)', hint: 'TLS verification remains enabled' },
    {
      key: 'failureThreshold',
      title: 'Failures before confirmation',
      hint: 'Consecutive failures from one vantage',
    },
    {
      key: 'readinessSuccesses',
      title: 'Readiness successes required',
      hint: 'Consecutive target readiness checks',
    },
    {
      key: 'bootDeadlineSeconds',
      title: 'Backup readiness deadline (seconds)',
      hint: 'Absolute deadline, preserved on restart',
    },
    {
      key: 'objectiveSeconds',
      title: 'Recovery objective (seconds)',
      hint: 'Measured objective, not a guarantee',
    },
    { key: 'cooldownSeconds', title: 'Cooldown (seconds)', hint: 'Wait before another recovery operation' },
    {
      key: 'failbackHealthySeconds',
      title: 'Failback health window (seconds)',
      hint: 'Manual failback requires sustained readiness',
    },
  ];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void action
          .run(`/applications/${app.id}/policy`, { revision: app.configurationRevision, policy }, 'PUT')
          .then(onSaved)
          .catch(() => {});
      }}
    >
      <div className="form-grid">
        {numbers.map((n) => (
          <label key={n.key}>
            {n.title}
            <input
              type="number"
              required
              value={policy[n.key] as number}
              onChange={(e) => setPolicy({ ...policy, [n.key]: Number(e.target.value) })}
            />
            <small>{n.hint}</small>
          </label>
        ))}
        <label>
          Confirmation strategy
          <select
            value={policy.confirmation}
            onChange={(e) => setPolicy({ ...policy, confirmation: e.target.value as Policy['confirmation'] })}
          >
            <option value="operator">Operator confirmation (conservative)</option>
            <option value="single-vantage">Automatic · single vantage (opt in)</option>
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={policy.maintenance}
            onChange={(e) => setPolicy({ ...policy, maintenance: e.target.checked })}
          />
          Maintenance mode
        </label>
      </div>
      <div className="notice">
        <Clock3 size={17} />
        Timing estimate: up to {policy.intervalSeconds * policy.failureThreshold + policy.timeoutSeconds}s to
        detect, plus provider boot time, {policy.intervalSeconds * policy.readinessSuccesses}s readiness
        observation, and routing verification. Assumes successful requests; this is not measured recovery.
      </div>
      <Feedback action={action} />
      <Button disabled={action.isPending}>Save policy</Button>
    </form>
  );
}
export function ApplicationPage() {
  const { id } = useParams();
  const data = useQuery({
    queryKey: ['application', id],
    queryFn: () => request<Application>(`/applications/${id}`),
  });
  const incidents = useQuery({
    queryKey: ['incidents'],
    queryFn: () => request<{ items: Incident[] }>('/incidents'),
  });
  const action = useAction();
  if (data.isPending) return <p className="notice">Loading application…</p>;
  if (data.isError)
    return (
      <p className="notice notice-error" role="alert">
        {data.error.message}
      </p>
    );
  const app = data.data;
  return (
    <>
      <Link className="breadcrumb" to="/applications">
        Applications
        <ChevronRight size={14} />
        {app.name}
      </Link>
      <Heading
        eyebrow={app.demo ? 'DEMO APPLICATION' : 'APPLICATION'}
        title={app.name}
        description={app.publicHostname}
        action={
          <Badge
            tone={
              app.operationalState === 'ACTIVE_BACKUP'
                ? 'blue'
                : app.operationalState.includes('FAILED')
                  ? 'red'
                  : 'neutral'
            }
          >
            {label(app.operationalState)}
          </Badge>
        }
      />
      <RecoveryActions app={app} />
      {app.operationalState === 'RECONCILIATION_REQUIRED' && (
        <section className="card padded">
          <h2>Routing needs reconciliation</h2>
          <p>
            The active route is unknown or partially changed. Inspect the real records and verify an origin
            before adopting the observed route.
          </p>
          <ReconcileAction app={app} />
        </section>
      )}
      <Tabs.Root defaultValue="summary" className="tabs">
        <Tabs.List aria-label="Application details" className="tab-list">
          {['Summary', 'Origins', 'Routing', 'Policy', 'Incidents'].map((t) => (
            <Tabs.Trigger key={t} value={t.toLowerCase()}>
              {t}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="summary">
          <RouteDiagram app={app} />
          <Latency app={app} />
          {app.demo && (
            <section className="card padded">
              <h2>Demo controls</h2>
              <p>
                Change local fixtures to observe detection and recovery. No production traffic is affected.
              </p>
              <div className="action-row">
                <Button
                  variant="destructive"
                  onClick={() =>
                    void action
                      .run(`/applications/${app.id}/demo`, { role: 'primary', healthy: false })
                      .catch(() => {})
                  }
                >
                  Simulate primary failure
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void action
                      .run(`/applications/${app.id}/demo`, { role: 'primary', healthy: true })
                      .catch(() => {})
                  }
                >
                  Restore primary
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void action
                      .run(`/applications/${app.id}/demo`, { role: 'backup', running: false })
                      .catch(() => {})
                  }
                >
                  Stop demo backup
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void action
                      .run(`/applications/${app.id}/demo`, { role: 'backup', healthy: false })
                      .catch(() => {})
                  }
                >
                  Make backup unready
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void action
                      .run(`/applications/${app.id}/demo`, {
                        role: 'backup',
                        healthy: true,
                        running: true,
                        dependencies: true,
                      })
                      .catch(() => {})
                  }
                >
                  Restore backup
                </Button>
              </div>
              <Feedback action={action} />
            </section>
          )}
        </Tabs.Content>
        <Tabs.Content value="origins">
          <div className="two-column">
            {app.origins.map((o) => (
              <section className="card padded" key={o.id}>
                <div className="card-heading compact">
                  <h2>{label(o.role)} origin</h2>
                  <Readiness origin={o} />
                </div>
                <dl className="review-list">
                  <div>
                    <dt>Direct address</dt>
                    <dd>
                      {o.address}:{o.port}
                    </dd>
                  </div>
                  <div>
                    <dt>Host / TLS SNI</dt>
                    <dd>{o.tlsHostname}</dd>
                  </div>
                  <div>
                    <dt>Readiness path</dt>
                    <dd>{o.readinessPath}</dd>
                  </div>
                  <div>
                    <dt>Expected identity</dt>
                    <dd>{o.expectedIdentity || 'None · weaker validation'}</dd>
                  </div>
                  <div>
                    <dt>Desired release</dt>
                    <dd>{app.desiredRelease || 'Not declared'}</dd>
                  </div>
                  <div>
                    <dt>Verified release</dt>
                    <dd>{o.observation?.release ?? 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Observed power</dt>
                    <dd>{o.power}</dd>
                  </div>
                  <div>
                    <dt>Last probe</dt>
                    <dd>{date(o.observation?.at)}</dd>
                  </div>
                </dl>
                {o.observation?.reason && <div className="notice notice-error">{o.observation.reason}</div>}
                <SshSettings app={app} origin={o} />
              </section>
            ))}
          </div>
        </Tabs.Content>
        <Tabs.Content value="routing">
          <section className="card padded">
            <h2>Approved routing</h2>
            <p>Only these existing records may change. External changes stop recovery for reconciliation.</p>
            <div className="record-plan">
              {app.routing?.snapshot.map((r) => (
                <div key={r.id}>
                  <Badge>{r.type}</Badge>
                  <strong>{r.name}</strong>
                  <code>{r.content}</code>
                  <small>
                    {r.proxied
                      ? 'Cloudflare proxied · provider-managed TTL'
                      : `DNS only · ${r.ttl === 1 ? 'automatic TTL' : `${r.ttl}s TTL`}, subject to client caches`}
                  </small>
                </div>
              )) ?? 'Routing not configured'}
            </div>
            <div className="notice">
              <Info size={17} />
              Cloudflare managed Load Balancing is unavailable in this MVP. This controller owns the selected
              DNS record contents.
            </div>
          </section>
        </Tabs.Content>
        <Tabs.Content value="policy">
          <section className="card padded">
            <h2>Recovery policy</h2>
            <PolicyEditor key={`${app.id}:${app.configurationRevision}`} app={app} />
          </section>
        </Tabs.Content>
        <Tabs.Content value="incidents">
          <section className="card">
            <IncidentList incidents={incidents.data?.items.filter((i) => i.applicationId === app.id) ?? []} />
          </section>
        </Tabs.Content>
      </Tabs.Root>
    </>
  );
}
export function ProvidersPage() {
  const data = useQuery({ queryKey: ['providers'], queryFn: () => request<ProviderView[]>('/providers') });
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('hostinger');
  const [editing, setEditing] = useState<ProviderView | null>(null);
  return (
    <>
      <Heading
        eyebrow="INTEGRATIONS"
        title="Providers"
        description="Scoped credentials. Read-only validation. Explicit resource controls."
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus size={16} />
            Add Provider
          </Button>
        }
      />
      <Feedback action={action} />
      {data.isPending && (
        <p role="status" className="notice">
          Loading provider connections…
        </p>
      )}
      {data.isError && (
        <p role="alert" className="notice notice-error">
          {data.error.message}
        </p>
      )}
      <div className="provider-grid">
        {data.data?.map((p) => (
          <section className="card padded provider" key={p.id}>
            <div className="provider-mark">
              <Cloud />
            </div>
            <h2>{p.label}</h2>
            <p>{p.type === 'aws' ? 'AWS EC2' : label(p.type)}</p>
            <Badge tone={p.validationState === 'Valid' ? 'green' : 'neutral'}>{p.validationState}</Badge>
            <dl>
              <div>
                <dt>Secret status</dt>
                <dd>{p.secretConfigured ? '•••••••• · encrypted' : 'Not required'}</dd>
              </div>
              <div>
                <dt>Resource scope</dt>
                <dd>{p.config.resourceIds.join(', ') || 'Not configured'}</dd>
              </div>
              <div>
                <dt>Last validation</dt>
                <dd>{date(p.lastValidated)}</dd>
              </div>
            </dl>
            <div className="action-row">
              <Button
                variant="outline"
                onClick={() => void action.run(`/providers/${p.id}/test`, {}).catch(() => {})}
              >
                Test read-only
              </Button>
              <Button
                variant="ghost"
                onClick={() => void action.run(`/providers/${p.id}`, {}, 'DELETE').catch(() => {})}
              >
                Remove
              </Button>
              {p.type !== 'generic' && (
                <Button variant="outline" onClick={() => setEditing(p)}>
                  Replace credentials
                </Button>
              )}
            </div>
          </section>
        ))}
        {data.isSuccess && !data.data.length && (
          <section className="card provider-empty">
            <Empty
              title="Connect your infrastructure"
              description="Add scoped AWS, Hostinger or Cloudflare credentials. The local demo needs none."
            />
          </section>
        )}
        <section className="card padded unavailable">
          <div className="provider-mark">
            <Globe2 />
          </div>
          <h2>Cloudflare Load Balancing</h2>
          <Badge>Phase two · unavailable</Badge>
          <p>
            Paid managed load balancing includes Cloudflare health checks and pool steering. It is not part of
            controller-owned DNS routing.
          </p>
          <small>One routing owner per hostname. Native failback and this controller must not compete.</small>
        </section>
      </div>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add provider connection"
        description="Secrets are encrypted and never returned to the dashboard."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const secret =
              type === 'aws'
                ? {
                    accessKeyId: String(f.get('accessKeyId')),
                    secretAccessKey: String(f.get('secretAccessKey')),
                  }
                : type === 'generic'
                  ? {}
                  : { token: String(f.get('token')) };
            void action
              .run('/providers', {
                type,
                label: f.get('label'),
                secret,
                config: {
                  region: f.get('region') || undefined,
                  resourceIds: String(f.get('scope') ?? '')
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
              })
              .then(() => setOpen(false))
              .catch(() => {});
          }}
        >
          <label>
            Provider
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="hostinger">Hostinger VPS</option>
              <option value="aws">AWS EC2</option>
              <option value="cloudflare">Cloudflare DNS</option>
              <option value="generic">Generic server</option>
            </select>
          </label>
          <label>
            Connection label
            <input name="label" required />
          </label>
          {type === 'aws' ? (
            <>
              <label>
                Access key ID
                <input name="accessKeyId" type="password" required autoComplete="off" />
              </label>
              <label>
                Secret access key
                <input name="secretAccessKey" type="password" required autoComplete="off" />
              </label>
              <label>
                Region
                <input name="region" placeholder="ap-south-1" required />
              </label>
            </>
          ) : (
            type !== 'generic' && (
              <label>
                API token
                <input name="token" type="password" required autoComplete="off" />
              </label>
            )
          )}
          {['aws', 'hostinger'].includes(type) && (
            <label>
              Allowed resource IDs
              <input name="scope" required placeholder="Comma-separated existing resource IDs" />
            </label>
          )}
          <Feedback action={action} />
          <Button disabled={action.isPending}>Save connection</Button>
        </form>
      </Dialog>
      <Dialog
        open={!!editing}
        onOpenChange={(shown) => {
          if (!shown) setEditing(null);
        }}
        title="Replace provider credentials"
        description="Enter new credentials. Saved secrets are never displayed or prefilled."
      >
        {editing && (
          <form
            key={editing.id}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const secret =
                editing.type === 'aws'
                  ? {
                      accessKeyId: String(form.get('accessKeyId')),
                      secretAccessKey: String(form.get('secretAccessKey')),
                    }
                  : { token: String(form.get('token')) };
              void action
                .run(`/providers/${editing.id}`, { secret }, 'PATCH')
                .then(() => setEditing(null))
                .catch(() => {});
            }}
          >
            {editing.type === 'aws' ? (
              <>
                <label>
                  New access key ID
                  <input name="accessKeyId" type="password" required autoComplete="off" />
                </label>
                <label>
                  New secret access key
                  <input name="secretAccessKey" type="password" required autoComplete="off" />
                </label>
              </>
            ) : (
              <label>
                New API token
                <input name="token" type="password" required autoComplete="off" />
              </label>
            )}
            <Feedback action={action} />
            <Button disabled={action.isPending}>Replace credentials</Button>
          </form>
        )}
      </Dialog>
    </>
  );
}
export function IncidentsPage() {
  const [offset, setOffset] = useState(0);
  const data = useQuery({
    queryKey: ['incidents', offset],
    queryFn: () => request<{ items: Incident[] }>(`/incidents?limit=25&offset=${offset}`),
  });
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get('selected'));
  const detail = useQuery({
    queryKey: ['incident', selected],
    queryFn: () => request<Incident & { steps: Step[] }>(`/incidents/${selected}`),
    enabled: !!selected,
  });
  const action = useAction();
  return (
    <>
      <Heading
        eyebrow="RECOVERY HISTORY"
        title="Incidents"
        description="Actual outcomes, measured durations and a persisted record of every phase."
      />
      <section className="card">
        {data.isError ? (
          <p className="notice notice-error" role="alert">
            {data.error.message}
          </p>
        ) : data.isPending ? (
          <p className="notice" role="status">
            Loading incident history…
          </p>
        ) : !data.data?.items.length ? (
          <Empty
            title="No incidents recorded"
            description="Use an application’s dry run or simulate a local demo failure to begin."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Phase</th>
                  <th>Outcome</th>
                  <th>Recovery</th>
                  <th>Objective</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.data.items.map((i) => (
                  <tr key={i.id}>
                    <td>{date(i.startedAt)}</td>
                    <td>{i.trigger}</td>
                    <td>{i.phase}</td>
                    <td>
                      <Badge tone={i.outcome === 'recovered' ? 'green' : i.outcome ? 'red' : 'blue'}>
                        {i.outcome ? label(i.outcome) : 'In progress'}
                      </Badge>
                    </td>
                    <td>
                      {i.completedAt
                        ? `${((i.completedAt - i.startedAt) / 1000).toFixed(1)}s`
                        : `${Math.max(0, Math.round((i.deadlineAt - Date.now()) / 1000))}s remaining`}
                    </td>
                    <td>{i.objectiveMet === null ? 'Unknown' : i.objectiveMet ? 'Met' : 'Missed'}</td>
                    <td>
                      <Button variant="ghost" onClick={() => setSelected(i.id)}>
                        Inspect
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 25))}>
            Previous
          </Button>
          <span>Page {Math.floor(offset / 25) + 1}</span>
          <Button
            variant="outline"
            disabled={(data.data?.items.length ?? 0) < 25}
            onClick={() => setOffset(offset + 25)}
          >
            Next
          </Button>
        </div>
      </section>
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Incident timeline"
        description="Persisted evidence from one controller vantage point."
        wide
      >
        {detail.isError ? (
          <p role="alert" className="error">
            {detail.error.message}
          </p>
        ) : detail.data ? (
          <>
            <div className="incident-meta">
              <Badge tone={detail.data.outcome === 'recovered' ? 'green' : 'amber'}>
                {detail.data.outcome ?? detail.data.phase}
              </Badge>
              <span>Actor: {detail.data.actor}</span>
              <span>Trigger: {detail.data.trigger}</span>
            </div>
            <dl className="review-list">
              <div>
                <dt>Correlation ID</dt>
                <dd>
                  <code>{detail.data.correlationId}</code>
                </dd>
              </div>
              <div>
                <dt>Previous / target</dt>
                <dd>
                  <code>
                    {detail.data.previousOriginId?.slice(0, 8) ?? 'Unknown'} →{' '}
                    {detail.data.targetOriginId.slice(0, 8)}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Absolute deadline</dt>
                <dd>{date(detail.data.deadlineAt)}</dd>
              </div>
              <div>
                <dt>Objective</dt>
                <dd>
                  {detail.data.objectiveMet === null
                    ? 'Unknown'
                    : detail.data.objectiveMet
                      ? 'Met'
                      : 'Missed'}
                </dd>
              </div>
            </dl>
            {detail.data.error && <div className="notice notice-error">{detail.data.error}</div>}
            <ol className="timeline">
              {detail.data.steps.map((s) => (
                <li key={s.id}>
                  <span className="timeline-dot" />
                  <div>
                    <div className="timeline-head">
                      <strong>{s.phase}</strong>
                      <time>{time(s.startedAt)}</time>
                    </div>
                    <p>{s.action}</p>
                    <small>{s.result}</small>
                    {s.completedAt && (
                      <span className="step-duration">
                        {((s.completedAt - s.startedAt) / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <Feedback action={action} />
            {!detail.data.outcome && (
              <Button
                variant="destructive"
                onClick={() => void action.run(`/incidents/${selected}/cancel`, {}).catch(() => {})}
              >
                Cancel · reconcile if routing was attempted
              </Button>
            )}
          </>
        ) : (
          <p>Loading timeline…</p>
        )}
      </Dialog>
    </>
  );
}
export function AuditPage() {
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('');
  const data = useQuery({
    queryKey: ['audit', offset, filter],
    queryFn: () =>
      request<{
        items: {
          id: number;
          actor: string;
          action: string;
          entity: string;
          timestamp: number;
          correlationId: string;
        }[];
      }>(`/audit-log?limit=50&offset=${offset}&action=${encodeURIComponent(filter)}`),
  });
  return (
    <>
      <Heading
        eyebrow="ACCOUNTABILITY"
        title="Audit Log"
        description="Operator actions and configuration changes. Secret values are excluded."
      />
      <label className="filter-input">
        Filter action
        <input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setOffset(0);
          }}
          placeholder="For example, automation.enabled"
        />
      </label>
      <section className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Correlation</th>
              </tr>
            </thead>
            <tbody>
              {data.data?.items.map((e) => (
                <tr key={e.id}>
                  <td>{date(e.timestamp)}</td>
                  <td>{e.actor}</td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td className="mono muted">{e.entity.slice(0, 12)}</td>
                  <td className="mono muted">{e.correlationId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={(data.data?.items.length ?? 0) < 50}
            onClick={() => setOffset(offset + 50)}
          >
            Next
          </Button>
        </div>
      </section>
    </>
  );
}
export function SettingsPage() {
  const data = useQuery({
    queryKey: ['settings'],
    queryFn: () =>
      request<{ location: string; retentionDays: number; webhookConfigured: boolean }>('/settings'),
  });
  const action = useAction();
  return (
    <>
      <Heading
        eyebrow="INSTALLATION"
        title="Settings"
        description="Manage the controller, your account and persistent data."
      />
      <div className="two-column">
        <section className="card padded">
          <h2>Controller configuration</h2>
          {data.data && (
            <form
              key={JSON.stringify(data.data)}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void action
                  .run(
                    '/settings',
                    { location: f.get('location'), retentionDays: Number(f.get('retentionDays')) },
                    'PATCH',
                  )
                  .catch(() => {});
              }}
            >
              <label>
                Installation location
                <input name="location" defaultValue={data.data.location} required />
                <small>Use an independent host outside the primary failure domain.</small>
              </label>
              <label>
                Raw probe retention (days)
                <input
                  type="number"
                  min="1"
                  max="30"
                  name="retentionDays"
                  defaultValue={data.data.retentionDays}
                />
                <small>Older probes aggregate hourly; aggregates are retained for 90 days.</small>
              </label>
              <Button>Save settings</Button>
            </form>
          )}
        </section>
        <section className="card padded">
          <h2>Change password</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action
                .run('/auth/password', {
                  currentPassword: f.get('currentPassword'),
                  password: f.get('password'),
                })
                .then(() => location.reload())
                .catch(() => {});
            }}
          >
            <label>
              Current password
              <input type="password" name="currentPassword" autoComplete="current-password" required />
            </label>
            <label>
              New password
              <input type="password" name="password" minLength={12} autoComplete="new-password" required />
            </label>
            <small>Changing your password signs out all sessions.</small>
            <Button>Update password</Button>
          </form>
        </section>
        <section className="card padded">
          <h2>Signed webhook notifications</h2>
          <p>
            Delivery is asynchronous and never delays recovery. Destinations follow the same network
            restrictions as probes.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void action
                .run('/settings/webhook', { url: f.get('url'), secret: f.get('secret') }, 'PUT')
                .catch(() => {});
            }}
          >
            <label>
              HTTPS destination
              <input
                name="url"
                type="url"
                required
                placeholder="https://your-service.example/notifications"
              />
            </label>
            <label>
              New signing secret
              <input name="secret" type="password" minLength={32} required autoComplete="off" />
            </label>
            <Button>Configure webhook</Button>
          </form>
        </section>
        <section className="card padded">
          <h2>Backup & restore</h2>
          <p>
            Use SQLite’s consistent online backup command. Preserve the matching master key separately from
            the database backup.
          </p>
          <code className="code-block">npm run backup -- data/backup.sqlite</code>
          <p>
            Restore with the controller stopped. Keep one replica and verify readiness before enabling
            automation.
          </p>
          <small>See docs/operations.md for key preservation, restore and versioned upgrades.</small>
        </section>
      </div>
      <Feedback action={action} />
    </>
  );
}
