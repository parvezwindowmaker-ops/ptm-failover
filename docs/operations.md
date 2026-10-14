# Installation, persistence and operations

Run Node 24 LTS or the supplied image. Environment contract:

| Variable | Meaning |
| --- | --- |
| `PORT` | Same-origin API/UI listener, default 8080 |
| `DATA_DIR` | SQLite/WAL and controller state directory, default data |
| `APP_BASE_URL` | Exact dashboard origin, used for mutation origin checks and secure cookies |
| `PTM_MASTER_KEY_FILE` | Read-only file containing exactly 64 hexadecimal characters (32 bytes) |
| `PTM_BOOTSTRAP_TOKEN_FILE` | Read-only random token file, minimum 32 characters |
| `AUTOMATION_DEFAULT` | Must be false; explicit application opt-in is required |
| `DEMO_MODE` | true isolates fake adapters and loopback fixtures; use separate storage |

SQLite uses WAL, foreign keys, immediate short transactions, a 5-second busy timeout, explicit migration tracking and local persistent disk. HTTP calls are outside write transactions. Raw probes retain 1–30 days, default 7, then aggregate hourly; aggregates retain 90 days. Keep storage capacity under observation. Incident/audit retention is manual in this first release.

The DB controller guard permits exactly one replica. Clean SIGTERM waits for in-flight work and releases guards. After a hard crash, a new process may have to wait up to 60 seconds for the previous controller guard; per-application leases expire after 30 seconds. Restart the service after that expiry. The worker resumes persisted incident phases with their original absolute deadline; it does not reset the recovery budget.

Every remote mutation checks lease ownership, generation, cancellation, deadline and configuration revision. Local fencing cannot revoke an already-sent remote HTTP request, and a process suspended between the fence check and a remote call can resume later. Provider APIs do not expose a shared fencing token. Use one replica; account for these remaining remote-action races. Unexpected or partial routing changes require operator inspection. No automatic rollback to an unready primary is performed.

## HTTPS access

Keep the Compose loopback binding. Put Caddy/nginx in front, serve TLS, and proxy to `127.0.0.1:8080`. Example Caddyfile:

```text
controller.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Set `APP_BASE_URL=https://controller.example.com`. The API does not trust arbitrary forwarded IP headers (`trustProxy=false`), so rate limiting behind a proxy uses the direct peer. Cookies are HTTP-only, SameSite Strict, and Secure on HTTPS. Mutations require matching Origin and an authenticated session CSRF token. Sessions expire server-side after 12 hours; password changes invalidate every session.

Mounted secret files are generated securely without terminal disclosure. On Unix ensure the container UID 1000 can read them with restrictive ownership/modes. On Windows keep their ACL limited to the owner/service identity. Tokens never populate edit forms. AES-256-GCM uses unique 96-bit nonces and authenticates version plus connection identity. Startup checks the installed key against an encrypted canary and existing credentials; wrong keys fail closed.

## Backup, restore and upgrades

Use the SQLite backup API, not a live copy without the WAL:

```sh
npm run backup -- /safe/path/ptm-backup.sqlite
```

For a container, an operator can stop the controller and export the whole volume consistently, or run an online SQLite backup with an appropriate SQLite tool against the mounted database. Keep the master key backup encrypted and separate. Losing the key makes stored credentials unusable. Provider/webhook tokens should be rotated at their sources when exposed.

To restore: stop the sole controller, preserve its current volume, restore the consistent backup as `/data/ptm.sqlite` with UID 1000 ownership, restore the matching master key, remove obsolete WAL/SHM files only while the database is stopped and after preserving them, then start one controller. Inspect pending incidents, current provider state and actual DNS before enabling automation. Pending outbox notifications may redeliver; consumers use `x-ptm-event-id` for deduplication.

Before upgrading, back up data and key and record the existing version/digest. Pull a versioned image, replace the one controller, and inspect `/api/v1/health/ready`, migrations and incident state. Roll back only to a schema-compatible image; otherwise restore the pre-upgrade database/key and reconcile real external routing first. Do not downgrade an incompatible live schema.

Key rotation is currently an offline operator procedure: back up the database/key, decrypt and re-encrypt every provider secret, webhook secret and installation canary with a fresh key using the same authenticated contexts inside one DB transaction, then replace the mounted key while the service is stopped. There is no automatic key-rotation API. Never change just the file without migrating ciphertext.

## Notifications

Configure an explicit HTTPS webhook destination and a new random signing secret of at least 32 characters under Settings. Destinations cannot use URL credentials, redirects, metadata/reserved addresses or unapproved private networks. Delivery runs independently of recovery through a persistent outbox with bounded exponential retries. Headers contain `x-ptm-timestamp`, `x-ptm-event-id` and `x-ptm-signature: sha256=...`. Verify HMAC-SHA256 over `timestamp + '.' + raw_body`, validate timestamp freshness, compare signatures in constant time and deduplicate event IDs. Demo mode never delivers real notifications.
