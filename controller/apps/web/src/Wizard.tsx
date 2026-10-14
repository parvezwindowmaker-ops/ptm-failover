import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Info, ShieldCheck } from 'lucide-react';
import { type Application, type ProviderView, type OriginConfig, originSchema } from '@ptm/contracts';
import { request } from './lib';
import { Badge, Button, Dialog } from './components/ui';
import { Feedback, PolicyEditor, RecoveryActions, useAction } from './pages';

const steps = [
  'Claim installation',
  'Independent controller',
  'Provider credentials',
  'Application',
  'Primary & backup',
  'Routing records',
  'Recovery policy',
  'Dependency checklist',
  'Preflight & drill',
  'Review & enable',
];
const dependencies = [
  'Durable database',
  'Compatible sessions / authentication',
  'Durable uploads',
  'TLS configured on both origins',
  'Image / release parity',
  'Backup capacity',
];
type Draft = {
  step: number;
  appId: string;
  name: string;
  publicHostname: string;
  desiredRelease: string;
  location: string;
};
const initial: Draft = { step: 0, appId: '', name: '', publicHostname: '', desiredRelease: '', location: '' };
export function Wizard({ open, onClose, demo }: { open: boolean; onClose: () => void; demo: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      return { ...initial, ...JSON.parse(localStorage.getItem('ptm-wizard') ?? '{}') };
    } catch {
      return initial;
    }
  });
  const [declarations, setDeclarations] = useState<string[]>([]);
  const [preflight, setPreflight] = useState<{
    ok: boolean;
    checks: { label: string; ok: boolean; source: string }[];
  } | null>(null);
  const app = useQuery({
    queryKey: ['application', draft.appId],
    queryFn: () => request<Application>(`/applications/${draft.appId}`),
    enabled: !!draft.appId && open,
  });
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => request<ProviderView[]>('/providers'),
    enabled: open,
  });
  const action = useAction();
  const navigate = useNavigate();
  useEffect(() => localStorage.setItem('ptm-wizard', JSON.stringify(draft)), [draft]);
  const next = () => setDraft((d) => ({ ...d, step: Math.min(9, d.step + 1) }));
  const update = (key: keyof Draft, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  async function advance() {
    try {
      if (draft.step === 1)
        await action.run(
          '/settings',
          { location: draft.location || 'Independent host · location not specified' },
          'PATCH',
        );
      if (draft.step === 3 && !draft.appId) {
        const created = (await action.run('/applications', {
          name: draft.name,
          publicHostname: draft.publicHostname,
          desiredRelease: draft.desiredRelease,
          demo,
        })) as Application;
        setDraft((d) => ({ ...d, appId: created.id, step: 4 }));
        return;
      }
      if (draft.step === 7 && app.data) {
        await action.run(
          `/applications/${app.data.id}/policy`,
          { revision: app.data.configurationRevision, policy: app.data.policy, declarations },
          'PUT',
        );
      }
      next();
    } catch {
      /* Server errors stay visible */
    }
  }
  function finish() {
    localStorage.removeItem('ptm-wizard');
    const id = draft.appId;
    setDraft(initial);
    onClose();
    navigate(`/applications/${id}`);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Application setup"
      description="Prepare and validate your recovery path. Automation stays paused until you enable it."
      wide
    >
      <div className="wizard-progress">
        <span>Step {draft.step + 1} of 10</span>
        <strong>{steps[draft.step]}</strong>
        <div>
          <span style={{ width: `${(draft.step + 1) * 10}%` }} />
        </div>
      </div>
      <div className="wizard-body">
        {draft.step === 0 && (
          <>
            <div className="wizard-success">
              <ShieldCheck size={32} />
              <h2>Installation claimed</h2>
              <p>Your owner account is configured. The mounted bootstrap token is single use.</p>
            </div>
            <div className="notice">
              Draft progress persists locally. Provider tokens and password inputs are cleared on reload.
            </div>
          </>
        )}
        {draft.step === 1 && (
          <>
            <h2>Give monitoring an independent home</h2>
            <p>
              Closing the dashboard does not stop monitoring. A controller hosted on your failed primary
              cannot direct recovery.
            </p>
            <label>
              Installation location
              <input
                value={draft.location}
                onChange={(e) => update('location', e.target.value)}
                placeholder="Independent VPS · Mumbai"
              />
            </label>
            <div className="notice">
              <Info size={17} />
              The managed application must be deployed on both origins. This controller image contains only
              the control plane.
            </div>
          </>
        )}
        {draft.step === 2 && (
          <>
            <h2>{demo ? 'Demo providers are isolated' : 'Connect your providers'}</h2>
            <p>
              {demo
                ? 'The demo uses local primary, backup and routing fixtures. It cannot send real provider mutations or notifications.'
                : 'Add scoped credentials, then validate them with read-only API requests before selecting resources.'}
            </p>
            {providers.data?.map((p) => (
              <div className="setup-provider" key={p.id}>
                <strong>{p.label}</strong>
                <Badge tone={p.validationState === 'Valid' ? 'green' : 'neutral'}>{p.validationState}</Badge>
                <small>{p.config.resourceIds.join(', ') || p.type}</small>
              </div>
            ))}
            {!demo && (
              <Link className="text-link" to="/providers" onClick={onClose}>
                Open Providers
                <ChevronRight size={15} />
              </Link>
            )}
          </>
        )}
        {draft.step === 3 && (
          <>
            <h2>What application are we protecting?</h2>
            <div className="form-grid">
              <label>
                Application name
                <input
                  value={draft.name}
                  disabled={!!draft.appId}
                  onChange={(e) => update('name', e.target.value)}
                  placeholder="Production API"
                />
              </label>
              <label>
                Public hostname
                <input
                  value={draft.publicHostname}
                  disabled={!!draft.appId}
                  onChange={(e) => update('publicHostname', e.target.value)}
                  placeholder={demo ? 'api.demo.local' : 'api.example.com'}
                />
              </label>
              <label>
                Desired release
                <input
                  value={draft.desiredRelease}
                  disabled={!!draft.appId}
                  onChange={(e) => update('desiredRelease', e.target.value)}
                  placeholder="2026.10.1"
                />
                <small>Exact release assertions protect against an incompatible backup.</small>
              </label>
            </div>
          </>
        )}
        {draft.step === 4 &&
          app.data &&
          (demo ? (
            <>
              <h2>Two prepared demo origins</h2>
              {app.data.origins.map((o) => (
                <div className="setup-provider" key={o.id}>
                  <strong>{o.role}</strong>
                  <span>127.0.0.1:{o.port}</span>
                  <code>{o.expectedIdentity}</code>
                </div>
              ))}
              <p>
                The backup is already running. You can stop it from the application’s demo controls to
                exercise provider start recovery.
              </p>
            </>
          ) : (
            <OriginsForm app={app.data} providers={providers.data ?? []} onSaved={next} />
          ))}
        {draft.step === 5 &&
          app.data &&
          (demo ? (
            <>
              <h2>Local routing simulator</h2>
              <p>
                Only local fixture routing changes. The application hostname is a label and does not need a
                public DNS record.
              </p>
              {app.data.routing?.snapshot.map((r) => (
                <div className="setup-provider" key={r.id}>
                  <Badge>{r.type}</Badge>
                  <strong>{r.name}</strong>
                  <code>{r.content}</code>
                </div>
              ))}
            </>
          ) : (
            <RoutingForm app={app.data} providers={providers.data ?? []} onSaved={next} />
          ))}
        {draft.step === 6 && app.data && (
          <>
            <h2>Choose your recovery policy</h2>
            <PolicyEditor key={app.data.configurationRevision} app={app.data} onSaved={next} />
            <div className="notice">
              Automatic single-vantage confirmation is an explicit opt-in. Repeated checks from this
              controller do not represent independent locations.
            </div>
          </>
        )}
        {draft.step === 7 && (
          <>
            <h2>Declare application preparedness</h2>
            <p>
              These are operator declarations. PTM Failover cannot validate database replication or transfer
              files, sessions, memory or running sockets.
            </p>
            <div className="dependency-list">
              {dependencies.map((d) => (
                <label className="checkbox" key={d}>
                  <input
                    type="checkbox"
                    checked={declarations.includes(d)}
                    onChange={(e) =>
                      setDeclarations((ds) => (e.target.checked ? [...ds, d] : ds.filter((x) => x !== d)))
                    }
                  />
                  {d}
                  <Badge>Declaration</Badge>
                </label>
              ))}
            </div>
            <div className="notice">
              If both origins depend on a database on the failed primary, routing failover cannot restore the
              application.
            </div>
          </>
        )}
        {draft.step === 8 && app.data && (
          <>
            <h2>Validate, then rehearse</h2>
            <p>
              Preflight is read-only. A failover drill changes traffic and requires its own reviewed
              confirmation.
            </p>
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() =>
                void action
                  .run(`/applications/${app.data!.id}/preflight`, {})
                  .then((p) => setPreflight(p as typeof preflight))
                  .catch(() => {})
              }
            >
              Run read-only preflight
            </Button>
            {preflight && (
              <ul className="preflight-list">
                {preflight.checks.map((c) => (
                  <li key={c.label}>
                    <Badge tone={c.ok ? 'green' : 'red'}>{c.ok ? 'Passed' : 'Needs attention'}</Badge>
                    <div>
                      <strong>{c.label}</strong>
                      <small>{c.source}</small>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="drill">
              <h3>{demo ? 'Separate demo drill' : 'Reviewed operational drill'}</h3>
              <RecoveryActions app={app.data} />
            </div>
          </>
        )}
        {draft.step === 9 && app.data && (
          <>
            <h2>Review your recovery path</h2>
            <dl className="review-list">
              <div>
                <dt>Application</dt>
                <dd>{app.data.name}</dd>
              </div>
              <div>
                <dt>Hostname</dt>
                <dd>{app.data.publicHostname}</dd>
              </div>
              <div>
                <dt>Origin pair</dt>
                <dd>{app.data.origins.length === 2 ? 'Primary and backup configured' : 'Incomplete'}</dd>
              </div>
              <div>
                <dt>Routing</dt>
                <dd>{app.data.routing?.type ?? 'Not configured'}</dd>
              </div>
              <div>
                <dt>Confirmation</dt>
                <dd>
                  {app.data.policy.confirmation === 'operator'
                    ? 'Operator review'
                    : 'Single-vantage automatic · opted in'}
                </dd>
              </div>
              <div>
                <dt>Objective</dt>
                <dd>{app.data.policy.objectiveSeconds}s · measured per incident</dd>
              </div>
            </dl>
            <p>
              The recovery objective depends on prepared origins, durable dependencies, provider response
              times and routing convergence.
            </p>
            <div className="action-row">
              <Button
                disabled={action.isPending}
                onClick={() =>
                  void action
                    .run(`/applications/${app.data!.id}/automation`, {
                      enabled: true,
                      revision: app.data!.configurationRevision,
                    })
                    .then(finish)
                    .catch(() => {})
                }
              >
                <Check size={16} />
                Enable automation & finish
              </Button>
              <Button variant="outline" onClick={finish}>
                Finish with automation paused
              </Button>
            </div>
          </>
        )}
        {app.isError && (
          <p role="alert" className="error">
            {app.error.message}
          </p>
        )}
        <Feedback action={action} />
      </div>
      <div className="wizard-footer">
        <Button
          variant="ghost"
          disabled={draft.step === 0 || action.isPending}
          onClick={() => setDraft((d) => ({ ...d, step: d.step - 1 }))}
        >
          <ChevronLeft size={16} />
          Back
        </Button>
        <small>Progress saved · no secrets stored in draft</small>
        {draft.step < 9 && !([4, 5].includes(draft.step) && !demo) && draft.step !== 6 && (
          <Button
            disabled={
              action.isPending ||
              (draft.step === 3 && (!draft.name || !draft.publicHostname)) ||
              (draft.step === 7 && declarations.length !== 6) ||
              (draft.step === 8 && !preflight?.ok)
            }
            onClick={() => void advance()}
          >
            Continue
            <ChevronRight size={16} />
          </Button>
        )}
      </div>
    </Dialog>
  );
}
function OriginsForm({
  app,
  providers,
  onSaved,
}: {
  app: Application;
  providers: ProviderView[];
  onSaved: () => void;
}) {
  const action = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        try {
          const origins: OriginConfig[] = (['primary', 'backup'] as const).map((role) =>
            originSchema.parse({
              role,
              providerConnectionId: f.get(`${role}.provider`) || null,
              resourceId: f.get(`${role}.resource`) || '',
              address: f.get(`${role}.address`),
              tlsHostname: f.get(`${role}.tls`),
              port: Number(f.get(`${role}.port`)),
              protocol: f.get(`${role}.protocol`),
              readinessPath: f.get(`${role}.path`),
              expectedIdentity: f.get(`${role}.identity`),
              ipv4: f.get(`${role}.ipv4`) || undefined,
              ipv6: f.get(`${role}.ipv6`) || undefined,
              startOnFailure: f.get(`${role}.start`) === 'on',
              approvedPrivateCidrs: String(f.get(`${role}.cidrs`) ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }),
          );
          void action
            .run(`/applications/${app.id}/origins`, { revision: app.configurationRevision, origins }, 'PUT')
            .then(onSaved)
            .catch(() => {});
        } catch {
          e.currentTarget.reportValidity();
        }
      }}
    >
      <h2>Configure explicit origins</h2>
      <p>
        Each direct destination preserves the configured Host and TLS SNI. TLS certificate verification is
        mandatory.
      </p>
      <div className="two-column">
        {(['primary', 'backup'] as const).map((role) => {
          const o = app.origins.find((o) => o.role === role);
          return (
            <fieldset key={role}>
              <legend>{role === 'primary' ? 'Primary' : 'Backup'}</legend>
              <label>
                Server provider
                <select name={`${role}.provider`} defaultValue={o?.providerConnectionId ?? ''}>
                  <option value="">Generic · readiness only</option>
                  {providers
                    .filter((p) => p.type !== 'cloudflare')
                    .map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Existing resource ID
                <input name={`${role}.resource`} defaultValue={o?.resourceId} />
              </label>
              <label>
                Direct origin IP / hostname
                <input name={`${role}.address`} required defaultValue={o?.address} />
              </label>
              <label>
                Host / TLS SNI
                <input name={`${role}.tls`} required defaultValue={o?.tlsHostname ?? app.publicHostname} />
              </label>
              <div className="form-grid">
                <label>
                  Protocol
                  <select name={`${role}.protocol`} defaultValue={o?.protocol ?? 'https'}>
                    <option>https</option>
                    <option>http</option>
                  </select>
                </label>
                <label>
                  Port
                  <input
                    name={`${role}.port`}
                    type="number"
                    min="1"
                    max="65535"
                    required
                    defaultValue={o?.port ?? 443}
                  />
                </label>
              </div>
              <label>
                Readiness path
                <input name={`${role}.path`} required defaultValue={o?.readinessPath ?? '/ready'} />
              </label>
              <label>
                Expected server identity
                <input name={`${role}.identity`} required defaultValue={o?.expectedIdentity} />
              </label>
              <label>
                IPv4 route target
                <input name={`${role}.ipv4`} defaultValue={o?.ipv4} />
              </label>
              <label>
                IPv6 route target
                <input name={`${role}.ipv6`} defaultValue={o?.ipv6} />
              </label>
              <label>
                Approved private CIDRs
                <input
                  name={`${role}.cidrs`}
                  defaultValue={o?.approvedPrivateCidrs.join(',')}
                  placeholder="Leave empty for public addresses"
                />
              </label>
              {role === 'backup' && (
                <label className="checkbox">
                  <input type="checkbox" name={`${role}.start`} defaultChecked={o?.startOnFailure} />
                  Start existing stopped resource on failure
                </label>
              )}
            </fieldset>
          );
        })}
      </div>
      <Feedback action={action} />
      <Button disabled={action.isPending}>Save origins & continue</Button>
    </form>
  );
}
function RoutingForm({
  app,
  providers,
  onSaved,
}: {
  app: Application;
  providers: ProviderView[];
  onSaved: () => void;
}) {
  const action = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void action
          .run(
            `/applications/${app.id}/routing`,
            {
              revision: app.configurationRevision,
              routing: {
                type: 'cloudflare',
                providerConnectionId: f.get('provider'),
                zoneId: f.get('zoneId'),
                recordIds: String(f.get('recordIds'))
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                dnsOnlyAcknowledged: f.get('dnsOnly') === 'on',
              },
            },
            'PUT',
          )
          .then(onSaved)
          .catch(() => {});
      }}
    >
      <h2>Approve the exact record set</h2>
      <p>
        Conflicting CNAMEs, extra A/AAAA routes or inconsistent proxy status must be resolved by the operator.
        PTM never deletes them.
      </p>
      <label>
        Cloudflare connection
        <select name="provider" required defaultValue={app.routing?.providerConnectionId ?? ''}>
          <option value="">Select connection</option>
          {providers
            .filter((p) => p.type === 'cloudflare')
            .map((p) => (
              <option value={p.id} key={p.id}>
                {p.label}
              </option>
            ))}
        </select>
      </label>
      <label>
        Zone ID
        <input name="zoneId" required defaultValue={app.routing?.zoneId} />
      </label>
      <label>
        Existing A / AAAA record IDs
        <input
          name="recordIds"
          required
          defaultValue={app.routing?.recordIds.join(',')}
          placeholder="Comma-separated exact record IDs"
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" name="dnsOnly" />I acknowledge that DNS-only records are subject to client
        caching and have no universal five-minute guarantee.
      </label>
      <div className="notice">
        Already-proxied Cloudflare records use provider-managed TTL. The controller patches only record
        content and preserves other flags.
      </div>
      <Feedback action={action} />
      <Button disabled={action.isPending}>Validate & approve records</Button>
    </form>
  );
}
