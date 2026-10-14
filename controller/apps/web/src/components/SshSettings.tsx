import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Application, Origin, SshView } from '@ptm/contracts';
import { request, date } from '../lib';
import { useAction } from '../pages';
import { Badge, Button, Dialog } from './ui';

export function SshSettings({ app, origin }: { app: Application; origin: Origin }) {
  const data = useQuery({
    queryKey: ['ssh', origin.id],
    queryFn: () => request<SshView | null>(`/origins/${origin.id}/ssh`),
    enabled: !app.demo,
  });
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const keyInput = useRef<HTMLInputElement>(null);
  if (app.demo)
    return (
      <div className="notice">
        <div>
          <strong>SSH access</strong>
          <p>
            Private-key uploads and outbound SSH are available in production mode. Demo origins are simulated.
          </p>
        </div>
      </div>
    );
  const connection = data.data;
  const busy = action.isPending || saving;
  return (
    <>
      <h3>SSH access</h3>
      {data.isPending ? (
        <p role="status">Loading SSH settings…</p>
      ) : data.isError ? (
        <p role="alert" className="error">
          {data.error.message}
        </p>
      ) : (
        <>
          <Badge
            tone={
              connection?.validationState === 'Valid'
                ? 'green'
                : connection?.validationState === 'Failed'
                  ? 'red'
                  : 'neutral'
            }
          >
            {connection?.validationState ?? 'Not configured'}
          </Badge>
          {connection && (
            <dl className="review-list">
              <div>
                <dt>Connection</dt>
                <dd>
                  {connection.username}@{origin.address}:{connection.port}
                </dd>
              </div>
              <div>
                <dt>Private key</dt>
                <dd>
                  •••••••• · encrypted{connection.passphraseConfigured ? ' · passphrase protected' : ''}
                </dd>
              </div>
              <div>
                <dt>Trusted host fingerprint</dt>
                <dd>
                  <code style={{ overflowWrap: 'anywhere' }}>{connection.hostFingerprint}</code>
                </dd>
              </div>
              <div>
                <dt>Last connection test</dt>
                <dd>{date(connection.lastTested)}</dd>
              </div>
            </dl>
          )}
          <p>
            Tests authenticate and disconnect. The key is never displayed, downloaded or used for shell
            commands.
          </p>
          <div className="action-row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError('');
                setOpen(true);
              }}
            >
              {connection ? 'Edit SSH settings' : 'Configure SSH'}
            </Button>
            {connection && (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setMessage('');
                    void action
                      .run(`/origins/${origin.id}/ssh/test`, {})
                      .then(() =>
                        setMessage(
                          'Connected: server fingerprint verified and private-key authentication succeeded.',
                        ),
                      )
                      .catch(() => {});
                  }}
                >
                  Test SSH connection
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setMessage('');
                    void action
                      .run(`/origins/${origin.id}/ssh`, { revision: app.configurationRevision }, 'DELETE')
                      .then(() => setMessage('Stored SSH credentials removed.'))
                      .catch(() => {});
                  }}
                >
                  Remove SSH credentials
                </Button>
              </>
            )}
          </div>
        </>
      )}
      {!open && action.isError && (
        <p className="error" role="alert">
          {action.error.message}
        </p>
      )}
      {message && (
        <p role="status" className="notice notice-success">
          {message}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(shown) => {
          if (!busy) setOpen(shown);
        }}
        title={`SSH access · ${origin.role}`}
        description="Upload a private key for this configured origin. Verify the server fingerprint through a trusted independent channel."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy) return;
            const form = event.currentTarget;
            const values = new FormData(form);
            const file = keyInput.current?.files?.[0];
            setError('');
            setMessage('');
            setSaving(true);
            void (async () => {
              try {
                if (file && (file.size === 0 || file.size > 32768))
                  throw new Error('Choose a non-empty private key file of at most 32 KiB.');
                if (!file && !connection) throw new Error('Upload a private key to configure SSH.');
                const privateKey = file ? await file.text() : undefined;
                await action.run(
                  `/origins/${origin.id}/ssh`,
                  {
                    revision: app.configurationRevision,
                    username: String(values.get('username')),
                    port: Number(values.get('port')),
                    hostFingerprint: String(values.get('fingerprint')).trim(),
                    ...(privateKey ? { privateKey, passphrase: String(values.get('passphrase') ?? '') } : {}),
                  },
                  'PUT',
                );
                form.reset();
                setOpen(false);
                setMessage('SSH settings saved. Test the connection to verify access.');
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'SSH settings could not be saved');
              } finally {
                setSaving(false);
              }
            })();
          }}
        >
          <p>
            <strong>Destination:</strong> {origin.address} (the configured origin address)
          </p>
          <label>
            SSH username
            <input
              name="username"
              required
              maxLength={64}
              pattern="[a-zA-Z0-9_.-]+"
              defaultValue={connection?.username ?? 'ubuntu'}
              autoComplete="off"
            />
          </label>
          <label>
            SSH port
            <input
              name="port"
              type="number"
              required
              min={1}
              max={65535}
              defaultValue={connection?.port ?? 22}
            />
          </label>
          <label>
            Server host fingerprint
            <input
              name="fingerprint"
              required
              placeholder="SHA256:…"
              pattern="SHA256:[A-Za-z0-9+/]{43}"
              defaultValue={connection?.hostFingerprint}
              autoComplete="off"
            />
          </label>
          <label>
            {connection ? 'Replacement private key (optional)' : 'Private key file'}
            <input ref={keyInput} name="key" type="file" required={!connection} />
          </label>
          <label>
            Key passphrase (if encrypted)
            <input name="passphrase" type="password" maxLength={1024} autoComplete="off" />
          </label>
          <p>
            OpenSSH and PEM keys are supported. Leave the replacement file empty to retain the stored key.
            Passphrases are saved only with a newly uploaded key.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button disabled={busy}>{busy ? 'Saving…' : 'Save SSH settings'}</Button>
        </form>
      </Dialog>
    </>
  );
}
