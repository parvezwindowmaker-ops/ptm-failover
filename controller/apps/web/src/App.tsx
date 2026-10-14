import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Activity,
  ArrowUpRight,
  Boxes,
  ChevronRight,
  Cloud,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Moon,
  Radio,
  Settings as SettingsIcon,
  ShieldCheck,
  Sun,
  TriangleAlert,
} from 'lucide-react';
import { credentialsSchema, type ControllerStatus } from '@ptm/contracts';
import { request, queryClient, setCsrf, time } from './lib';
import { Badge, Button } from './components/ui';
import {
  OverviewPage,
  ApplicationsPage,
  ApplicationPage,
  ProvidersPage,
  IncidentsPage,
  AuditPage,
  SettingsPage,
} from './pages';
import { Wizard } from './Wizard';

type Session = { claimed: boolean; username: string | null; csrfToken: string | null };
const claimForm = credentialsSchema.extend({
  bootstrapToken: z.string().min(32, 'Enter the token from your mounted bootstrap file'),
});
function Auth({ claimed }: { claimed: boolean }) {
  const schema = claimed ? credentialsSchema.extend({ bootstrapToken: z.string().optional() }) : claimForm;
  const form = useForm<z.input<typeof schema>>({ resolver: zodResolver(schema) });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(input: z.input<typeof schema>) {
    setBusy(true);
    setError('');
    try {
      const data = await request<Session>(claimed ? '/auth/login' : '/setup/claim', input);
      setCsrf(data.csrfToken ?? '');
      await queryClient.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth">
      <div className="auth-story">
        <Logo />
        <div>
          <Badge tone="blue">YOUR RECOVERY CONTROL PLANE</Badge>
          <h1>
            Keep your hostname.
            <br />
            <span>Recover your service.</span>
          </h1>
          <p>Direct origin monitoring. Reviewed traffic changes. A clear record of every recovery.</p>
          <div className="auth-steps">
            <span>
              <Activity /> Observe
            </span>
            <ChevronRight />
            <span>
              <ShieldCheck /> Validate
            </span>
            <ChevronRight />
            <span>
              <Radio /> Recover
            </span>
          </div>
        </div>
        <small>Self-hosted · Single owner · You control the routing</small>
      </div>
      <section className="auth-form">
        <ShieldCheck className="auth-icon" />
        <h2>{claimed ? 'Welcome back' : 'Claim your installation'}</h2>
        <p>
          {claimed
            ? 'Sign in to your PTM Failover controller.'
            : 'Create the owner account using your one-time bootstrap credential.'}
        </p>
        <form onSubmit={form.handleSubmit(submit)}>
          {!claimed && (
            <label>
              Bootstrap token
              <input type="password" autoComplete="off" {...form.register('bootstrapToken')} />
              <small>Open secrets/bootstrap-token privately. The credential is consumed once.</small>
            </label>
          )}
          <label>
            Username
            <input autoComplete="username" {...form.register('username')} />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete={claimed ? 'current-password' : 'new-password'}
              aria-label="Password"
              {...form.register('password')}
            />
            <small>At least 12 characters.</small>
          </label>
          {Object.values(form.formState.errors).map((e, i) => (
            <p className="error" key={i}>
              {e?.message}
            </p>
          ))}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button disabled={busy} type="submit">
            {busy ? 'Please wait…' : claimed ? 'Sign in' : 'Create owner account'}
            <ArrowUpRight size={16} />
          </Button>
        </form>
        <div className="note">
          <ShieldCheck size={16} />
          <span>Host this controller outside your primary server’s failure domain.</span>
        </div>
      </section>
    </main>
  );
}
export function Logo() {
  return (
    <div className="logo">
      <span className="logo-icon">
        <Activity size={23} />
      </span>
      <span>
        PTM<span className="logo-sub">Failover</span>
      </span>
    </div>
  );
}
const nav = [
  { path: '/', name: 'Overview', icon: LayoutDashboard },
  { path: '/applications', name: 'Applications', icon: Boxes },
  { path: '/providers', name: 'Providers', icon: Cloud },
  { path: '/incidents', name: 'Incidents', icon: TriangleAlert },
  { path: '/audit', name: 'Audit Log', icon: ListChecks },
  { path: '/settings', name: 'Settings', icon: SettingsIcon },
];
export function App() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => request<Session>('/auth/session'),
    refetchInterval: 30000,
  });
  const authenticated = !!session.data?.username;
  const controller = useQuery({
    queryKey: ['controller'],
    queryFn: () => request<ControllerStatus>('/controller/status'),
    enabled: authenticated,
  });
  const [wizard, setWizard] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('ptm-theme') ?? 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('ptm-theme', theme);
  }, [theme]);
  useEffect(() => {
    setCsrf(session.data?.csrfToken ?? '');
  }, [session.data?.csrfToken]);
  useEffect(() => {
    if (!authenticated) return;
    const stream = new EventSource('/api/v1/events');
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener('update', () => {
      void queryClient.invalidateQueries();
    });
    stream.addEventListener('heartbeat', (event) => {
      queryClient.setQueryData(['controller'], JSON.parse((event as MessageEvent).data));
    });
    return () => stream.close();
  }, [authenticated]);
  if (session.isPending) return <div className="loading-page">Connecting to your controller…</div>;
  if (session.isError)
    return (
      <div className="loading-page">
        <h2>Controller unavailable</h2>
        <p role="alert">{session.error.message}</p>
        <Button onClick={() => void session.refetch()}>Reconnect</Button>
      </div>
    );
  if (!authenticated) return <Auth claimed={session.data.claimed} />;
  const add = () => setWizard(true);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className={mobileNav ? 'sidebar sidebar-open' : 'sidebar'}>
        <Logo />
        <div className="sidebar-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <NavLink key={n.path} to={n.path} end={n.path === '/'} onClick={() => setMobileNav(false)}>
              <n.icon size={19} />
              {n.name}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="objective">
            <ShieldCheck size={21} />
            <strong>Prepared for recovery</strong>
            <p>
              300s objective.
              <br />
              Measured on every incident.
            </p>
          </div>
          <span className="sidebar-version">
            PTM Failover <Badge>v0.1.0</Badge>
          </span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="top-left">
            <Button
              variant="ghost"
              className="mobile-menu"
              aria-label="Toggle navigation"
              onClick={() => setMobileNav(!mobileNav)}
            >
              <Menu size={20} />
            </Button>
            <Badge tone={controller.data?.healthy ? 'green' : 'amber'}>
              {controller.data?.healthy ? 'Controller healthy' : 'Worker unknown'}
            </Badge>
            <span className="heartbeat">Heartbeat {time(controller.data?.heartbeat)}</span>
          </div>
          <div className="top-right">
            <span className={`connection ${connected ? '' : 'disconnected'}`}>
              <span />
              {connected ? 'Live' : 'Polling / reconnecting'}
            </span>
            <Button
              variant="ghost"
              aria-label={theme === 'light' ? 'Use dark theme' : 'Use light theme'}
              onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            >
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </Button>
            <span className="avatar">{session.data.username?.slice(0, 1).toUpperCase()}</span>
            <span className="username">{session.data.username}</span>
            <Button
              variant="ghost"
              aria-label="Sign out"
              onClick={() => void request('/auth/logout', {}).then(() => queryClient.invalidateQueries())}
            >
              <LogOut size={17} />
            </Button>
          </div>
        </header>
        {controller.data?.demo && (
          <div className="demo-banner">
            <span>
              <Radio size={15} />
              <strong>Demo environment</strong> · Local simulated origins and routing
            </span>
            <span>No production provider writes</span>
          </div>
        )}
        <main id="main" className="main">
          <Routes>
            <Route path="/" element={<OverviewPage onAdd={add} />} />
            <Route path="/applications" element={<ApplicationsPage onAdd={add} />} />
            <Route path="/applications/:id" element={<ApplicationPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/incidents" element={<IncidentsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <footer className="footer">
            <span>Single-instance controller · Monitoring runs independently of this dashboard</span>
            <span>All times shown in your browser’s local timezone</span>
          </footer>
        </main>
      </div>
      <Wizard open={wizard} onClose={() => setWizard(false)} demo={controller.data?.demo ?? false} />
    </div>
  );
}
