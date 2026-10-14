# PTM Failover — complete AI implementation prompt

Copy everything between BEGIN PROMPT and END PROMPT into your coding AI. Give the AI access to an empty repository and a terminal. This document specifies the app to build; it does not represent an already built or tested product.

BEGIN PROMPT

You are a senior full-stack engineer responsible for implementing a self-hosted server failover product named PTM Failover. Build working frontend and backend code, an executable local demo, meaningful tests, and a distributable Docker image. Complete the implementation in the repository. Do not stop at scaffolding, designs, pseudocode, or a plan.

## 1. Product and concrete scenario

A customer has an application on AWS EC2, a prepared backup VPS on Hostinger, and an API hostname managed in Cloudflare. PTM Failover monitors the primary application. When a confirmed failure occurs, it starts the existing backup if needed, validates readiness, switches the configured hostname to the backup, verifies service through the public hostname, records recovery time, and notifies the operator. The hostname remains unchanged.

Distribute one versioned Docker image containing the dashboard, API, and monitoring/orchestration worker. Users pull it, mount persistent storage and secrets, open a setup wizard, configure credentials and servers, test their setup, and explicitly enable automation.

Target recovery time is 300 seconds for appropriately prepared environments. Treat this as a measurable objective, not a guarantee. Show actual timings, failed phases, and the remaining time budget. Never claim that routing failover transfers running processes, memory, WebSockets, databases, or local files.

## 2. MVP boundaries and implementation order

Implement a single-owner self-hosted installation managing multiple applications. Implement one primary and one backup per application. Support application HTTP/HTTPS traffic. Ship these functional integrations:

- Generic existing server: monitor readiness; no provider power controls.
- Hostinger VPS: list/inspect existing VPS resources and start an existing stopped VPS.
- AWS EC2: inspect and start an existing EC2 instance using the official SDK. A primary EC2 may instead be monitored as a generic server without AWS credentials.
- Cloudflare routing: update explicitly selected existing A/AAAA records for the application hostname. Support already-proxied records as the primary MVP routing mode; label DNS-only mode as subject to client DNS caching and outside a strict universal five-minute promise.
- Demo: separate fake provider and routing adapters with no outbound provider mutations.

Cloudflare Load Balancing is a phase-two integration. Show it as unavailable until fully implemented; do not create a functional-looking button backed by fake production behavior. Document how paid managed LB differs from the controller-owned DNS integration. Never allow Cloudflare native failback and this controller to compete for routing ownership.

Do not implement automatic VM purchase, reprovisioning, database promotion, arbitrary remote shell execution, Kubernetes, billing, or teams in MVP. Future adapters can be added through defined interfaces.

Build the vertical slice first: bootstrap account -> add an application -> configure two demo origins -> observe probes -> simulate failure -> execute a persisted failover -> inspect incident history -> restart and retain state. Then implement and contract-test real provider adapters. Then finish UI, packaging, documentation, and verification.

## 3. Stack and deployment architecture

Use TypeScript throughout. Frontend: React, Vite, Tailwind CSS, accessible shadcn/ui components, Lucide icons, React Router, TanStack Query, React Hook Form and Zod. Use Recharts for meaningful metrics. Backend: Node.js on a current supported LTS release, Fastify, Zod request validation, structured logging, SQLite with explicit migrations, and a typed ORM or query layer. Use a maintained authenticated-encryption implementation and a maintained password hashing library. Check official documentation before choosing package versions; pin dependencies and commit a lockfile.

Serve the compiled UI and API from the same HTTP origin and port 8080. The Node service also supervises background probes and orchestration. Monitoring must run without any browser open. Browser updates use authenticated SSE with reconnect support, bounded buffers, and event IDs; polling fallback is acceptable.

Persist SQLite, incidents, configuration, and worker progress under /data. SQLite uses WAL, a busy timeout, migrations, and local persistent disk. Keep expensive HTTP calls outside write transactions. Support exactly one controller replica in MVP, with a startup guard; do not imply that mounting one SQLite database into multiple containers gives a highly available controller. Use transactionally persisted per-application operation leases and generation checks. Explain the remaining limitations of fencing remote actions when a paused process resumes.

The controller must be hosted outside the primary failure domain. Closing the dashboard must never stop monitoring. The managed application is deployed independently on both origins; the controller image is not the application image.

Suggested repository: apps/web, apps/api, packages/contracts, packages/providers, packages/routing, packages/orchestrator, tests, examples, docs. Keep common types in a real shared package. Prefer small clear modules over unnecessary microservices.

## 4. Exact UI design

Create a professional infrastructure dashboard. Default light theme: page #F8FAFC, white surfaces, text #0F172A, secondary text #64748B, borders #E2E8F0, primary #2563EB, healthy #16A34A, degraded #D97706, failed #DC2626. Use a system sans-serif stack, modest shadows, 12px card radius, 16px page padding on mobile and 24px on desktop. Desktop sidebar is approximately 240px wide. Include accessible dark mode and persistent theme preference.

Navigation: Overview, Applications, Providers, Incidents, Audit Log, Settings. Top bar shows controller health, last worker heartbeat, connection status and user menu. No decorative charts, fake uptime, random animated counters, or fabricated CPU metrics. Display Unknown when real data is missing.

### First-run wizard

1. Claim installation using a bootstrap token from a mounted secret file; create owner username and password.
2. Explain what is monitored and recommend an independent controller host. Let the user enter a descriptive installation location.
3. Add provider credentials through masked inputs. Test with read-only API requests; show resource availability and required permissions without exposing secret values.
4. Add application name and public hostname.
5. Configure primary and backup: provider/resource IDs, explicit origin IP or hostname, HTTPS hostname for TLS/SNI, port, readiness path, expected HTTP status, optional response assertions, server identity and allowed release policy. Select already-running or start-on-failure backup.
6. Configure exact Cloudflare zone and DNS record IDs. Display existing record set, proxy status, IPv4/IPv6 configuration and proposed changes. Detect conflicting CNAME, extra A/AAAA routes, or inconsistent proxy status. Require the operator to resolve ambiguous records instead of deleting them automatically.
7. Configure failure thresholds, observation interval, confirmation strategy, readiness deadline, incident deadline, and cooldown.
8. Show dependency checklist: shared durable database, shared sessions or compatible authentication keys, uploads, TLS, image/version parity, and backup capacity. Label these as operator declarations or actual validations appropriately.
9. Run read-only preflight and a separate demo drill. Mark operational drills on real origins as traffic-affecting actions requiring a specific confirmation.
10. Show review, then enable automation only through an explicit user action. Persist draft wizard progress with all secret inputs cleared on reload.

### Overview

Four truthful KPI cards: applications monitored, unhealthy origins, open incidents, and measured last recovery time. Include a table with application name, domain, active origin, primary readiness, backup readiness or power state, automation mode and last probe time. A selected application panel shows primary -> public hostname -> backup routing relationships with accessible status labels. Include a latency chart, recent incidents, and controller status. Empty installations get a useful Add Application flow.

### Application details

Tabs: Summary, Origins, Routing, Policy, Incidents. Show origin identity, desired application release, last verified release, readiness checks, and freshness. Actions: Check Now, Pause Automation, Dry Run, Fail Over, Fail Back. Manual actions are server-authorized and use a review dialog listing actual provider/routing changes. Dry Run performs no remote writes. Fail Back is manual in MVP and requires sustained primary readiness.

Policy editor shows interval, timeout, failures before confirmation, readiness successes required, boot deadline, total objective, maintenance mode and cooldown. Include a textual timing estimate with assumptions; never show it as a measured guarantee.

### Incident details

Show chronological events with timestamps, correlation ID, trigger, actor, old/new active origin, durations, per-step statuses, sanitized errors, route verification result and whether the recovery objective was met. Show failed and unknown outcomes clearly. Use Observe, Prepare Backup, Validate, Switch Traffic, Verify, Complete as human-facing phase labels. Provide a cancel action whose behavior depends on whether traffic was already changed.

### Providers and settings

Provider cards show configured resource scopes, last credential validation, capability badges, and masked secret status. Editing a token must require entering a new token; never return the old one to populate the UI. Settings include password changes, session logout, data retention, webhook configuration and backup/restore guidance.

Every screen needs loading, empty, unauthorized, disconnected, stale and error states. Support keyboard navigation, focus restoration, labels, reduced motion, readable contrast, mobile tables/cards and error announcements.

## 5. Backend API contract

Use /api/v1. Provide a typed OpenAPI description and generated or shared client types. Implement:

- POST /setup/claim: consume valid bootstrap credential once, transactionally create owner.
- POST /auth/login; POST /auth/logout; GET /auth/session.
- GET /overview; GET /controller/status.
- GET/POST /providers; PATCH/DELETE /providers/:id; POST /providers/:id/test; GET /providers/:id/resources.
- GET/POST /applications; GET/PATCH /applications/:id.
- PUT /applications/:id/origins; PUT /applications/:id/routing; PUT /applications/:id/policy.
- POST /applications/:id/check; POST /applications/:id/preflight.
- POST /applications/:id/dry-run; POST /applications/:id/failover; POST /applications/:id/failback.
- POST /applications/:id/automation with an explicit enabled boolean.
- GET /applications/:id/probes with bounded windows and aggregation.
- GET /incidents; GET /incidents/:id; POST /incidents/:id/cancel.
- GET /audit-log with filtering and pagination; GET /events for authenticated SSE.
- GET /health/live and GET /health/ready for the controller itself.

Long-running mutation endpoints return 202 with an operation ID. Enforce idempotency keys, operation conflict responses, configuration revisions and per-application locking. Use a consistent envelope containing code, message, fieldErrors, correlationId and retryable when relevant. Paginate history; bound queries. Revalidate permission and configuration server-side for every action. Block editing topology during an active incident unless a safe explicit cancel/reconcile flow is used.

## 6. Persistent data model

Create migrations and foreign keys for these entities:

- users: owner username, passwordHash, timestamps.
- sessions: hashed random token, userId, expiry, lastSeen.
- provider_connections: type, label, encrypted secret blob, encryption version, public configuration, last validation state.
- applications: name, publicHostname, desiredRelease, activeOriginId, operationalState, automationEnabled, configurationRevision.
- origins: applicationId, primary/backup role, providerConnectionId, resourceId, explicit network address, TLS hostname, port, readiness config, expectedIdentity, last readiness/power observation.
- routing_configs: type, Cloudflare zone/record IDs, approved original record snapshot, current observed target, revision.
- failover_policies: intervals, thresholds, confirmation mode, total deadline, boot deadline, cooldown, readiness count, maintenance flags.
- probe_results: originId, timestamp, success, HTTP status, latency, bounded sanitized reason, observed identity/release.
- incidents: trigger, actor, phase, target origin, previous origin, startedAt, deadlineAt, completedAt, outcome, objectiveMet.
- incident_steps: sequence, phase, desired action, request intent, attempts, startedAt, result, sanitized error and provider request IDs.
- operation_leases: applicationId, ownerId, generation, expiresAt.
- audit_events: actor, action, entity, non-secret diff, timestamp, correlationId.
- notification_outbox: event, destination, bounded payload, attempts, nextAttemptAt, delivery status.

Index common filters. Store dates consistently in UTC and render in a selected local timezone. Aggregate old probe data and enforce retention. Database backups must use a supported consistent SQLite backup mechanism, not an unsafe copy of a live database without its WAL.

## 7. Durable failover state machine

Use distinct states: HEALTHY_PRIMARY, SUSPECT_PRIMARY, CONFIRMING_FAILURE, PREPARING_BACKUP, WAITING_BACKUP_READY, SWITCHING_TRAFFIC, VERIFYING_TRAFFIC, ACTIVE_BACKUP, FAILBACK_IN_PROGRESS, RECONCILIATION_REQUIRED, FAILED, PAUSED. Separate incident phase/outcome from application health; marking an operation failed must not invent a working active origin.

Suggested defaults: primary check every 15 seconds, request timeout 5 seconds, three consecutive failures, backup readiness two consecutive successes, total objective 300 seconds, configurable backup boot deadline and cooldown. Explain that these defaults alone do not confirm a provider-wide outage.

After failures, inspect origin-specific evidence and backup/shared dependency readiness. Do not probe only the public hostname: once switched it points at the backup. Use explicit origin addressing while preserving Host and HTTPS SNI. Require TLS verification. Probe identities and releases where available; do not count a response from the wrong server as success.

Offer a conservative confirmation policy. MVP can require an operator confirmation, or explicitly opted-in single-vantage automatic failover with its uncertainty visible. If implementing a second probe agent, authenticate reports, verify timestamps, and reject stale/replayed reports. Never label repeated probes from one host as multiple independent locations. Shared dependency failures should be classified separately, not cause endless server startups.

On confirmed failure:

1. Create the incident, snapshot approved config, acquire lease, persist absolute deadlines.
2. If backup is stopped and power control exists, persist start intent, call start, then poll actual power state. VM running is not application ready. If already running, skip the mutation.
3. Probe backup directly until ready, with dependency and release assertions. Do not change routing if readiness fails or budget expires.
4. Re-read managed records and compare against the approved snapshot/revision. Unexpected operator changes produce RECONCILIATION_REQUIRED, not an overwrite.
5. Persist routing intent, update the approved record set and read it back. Treat partially changed A/AAAA records as a partial routing operation needing reconciliation. Do not report success merely because an API request returned 200.
6. Verify the public application with cache bypass and an identity assertion. Keep readiness and identity responses out of CDN caches and avoid exposing sensitive diagnostics publicly. API configuration readback and one public probe do not prove global convergence; show the measured scope.
7. Record ACTIVE_BACKUP only after successful reconciliation/verification. Persist recovery duration and outbox notification.

Bound retries, use jitter and backoff, honor Retry-After, and retain the original deadline across restarts. A provider timeout after a start or routing mutation has an unknown outcome: inspect actual state before repeating. Recheck lease ownership and revision before every remote mutation. Recover nonterminal incidents on process startup. A stale worker must not proceed with an old desired state.

Do not automatically shut down the primary. Recovery of the primary must not cause automatic failback in MVP. Show healthy primary as Ready for reviewed failback after a sustained health window. Starting or stopping application workers and preventing duplicate jobs requires workload-specific leases/fencing and is outside pure DNS switching. Document this clearly.

Cancel before routing leaves the current route intact. Cancel after a routing intent may have executed requires reconciliation; it must not blindly restore a failed origin. Never automatically roll traffic back to an unready primary.

## 8. Provider and routing adapter contracts

Define ServerProvider with capabilities(), validateCredentials(), listResources(), inspectResource(), startResource(). Support unavailable capabilities explicitly. Use AWS SDK EC2 DescribeInstances/StartInstances with restricted instance scope where applicable; document required IAM policy. Keep automatic StopInstances disabled.

For Hostinger use official current REST docs/SDK reference. Base URL is https://developers.hostinger.com. The documented start path is POST /api/vps/v1/virtual-machines/{virtualMachineId}/start and details path is GET /api/vps/v1/virtual-machines/{virtualMachineId}. Verify payloads, enums, asynchronous behavior, limits and authentication before implementing. Do not invent readiness from undocumented provider statuses.

Define TrafficRouter with validateConfiguration(), readRoute(), planSwitch(), applySwitch(), inspectConvergence(). For Cloudflare use scoped API tokens and the official DNS record API. Preserve unrelated flags and records. Handle IPv4/IPv6 consistently; prevent stale AAAA targets bypassing the intended switch. DNS-only mode requires an explicit effective-TTL discussion. Already-proxied Cloudflare records use provider-managed TTL; do not promise a configurable 30-second TTL for proxied records. Never change nameservers or delete the customer's zone.

Separate plan/read from apply/mutation. A dry run calls no provider write APIs. Real verification is credential- and environment-dependent; mocked contract tests are not proof of live recovery.

## 9. Application preparation and boot guide

Ship a guide and a reference Compose/systemd setup for the customer's managed application. Preinstall Docker, configure auto-start, pre-pull the pinned tested image on both servers, install appropriate secrets, configure TLS, and validate that the backup reaches durable dependencies. Avoid downloading source or rebuilding during an incident. Do not run destructive migrations automatically on failover.

Provide a reference readiness contract returning status, serverId, release and essential dependency status. Explain how to integrate this into an existing Node backend without making production diagnostics publicly sensitive. Use explicit expected assertions; generic applications without this endpoint can use a configured HTTP readiness check with visible weaker validation.

State that database HA/replication, data-loss objectives, local upload replication, in-memory sessions, singleton jobs, application-level leases and WebSocket replay are customer architecture responsibilities. If both origins require a database on the failed primary, failover cannot restore the app. Existing sockets disconnect; clients reconnect and fetch missed durable messages. Request retries require idempotency for payments and similar writes.

## 10. Security and installation

No default credentials, no secrets baked into images, no raw provider tokens in logs/API responses/exports/frontend bundles. Claim bootstrap token exactly once using a database transaction. Use password hashing, HTTP-only SameSite session cookies, CSRF protection on mutations, login throttling, server-side session expiry and trusted proxy configuration. Secure cookies must be enabled in HTTPS production mode; document localhost development separately.

Encrypt stored provider/webhook secrets with AES-256-GCM or a maintained equivalent using a master key read from a mounted secret file. Validate key length, use a unique nonce and authenticated context, fail closed on decryption errors, and document key preservation/rotation. Back up the database and key separately; losing the key makes encrypted credentials unusable. Mount the bootstrap token and key read-only. Do not print them.

Origin probes intentionally access configured infrastructure. Protect against SSRF: allow only configured destinations and protocols, reject URL userinfo, disable redirects by default, limit response size/time, resolve and validate addresses on every request and connection, block metadata/link-local/reserved destinations, and allow private subnets only through explicit operator-approved CIDRs. Use equivalent restrictions for webhook destinations. Provider API hosts are fixed allowlisted HTTPS destinations. Do not forward credentials across hosts or disable TLS verification. Validate Host/SNI overrides against the configured application scope.

The container runs non-root without privileged mode, host networking or a Docker socket mount. Remote starts occur through provider APIs. Reinstallation, deletion, purchase and arbitrary shell endpoints do not exist. Server-side checks enforce the confirmed action plan and configuration revision.

Default Compose binding is 127.0.0.1:8080; documentation includes SSH tunneling for first-run remote access and HTTPS reverse proxy setup for regular access. Do not recommend an unauthenticated public setup page. Outbound notifications are explicit customer configuration; signed webhooks retry through the outbox without delaying recovery.

## 11. Docker delivery

Create a multi-stage Dockerfile building frontend and backend and installing production-only dependencies. Verify native SQLite dependencies on supported architectures. Publish documentation for linux/amd64 and linux/arm64 using Docker Buildx. Supply Compose, .dockerignore, .env.example without secrets, HEALTHCHECK, migration startup, SIGTERM handling, writable /data ownership and a supported upgrade/rollback procedure.

Use the following installation contract, implementing these variables exactly or updating all examples consistently:

```yaml
services:
  controller:
    image: ${PTM_FAILOVER_IMAGE:?Set a published versioned image reference}
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      NODE_ENV: production
      PORT: "8080"
      DATA_DIR: /data
      APP_BASE_URL: ${APP_BASE_URL:-http://localhost:8080}
      PTM_MASTER_KEY_FILE: /run/secrets/ptm_master_key
      PTM_BOOTSTRAP_TOKEN_FILE: /run/secrets/ptm_bootstrap_token
      AUTOMATION_DEFAULT: "false"
    secrets:
      - ptm_master_key
      - ptm_bootstrap_token
    volumes:
      - ptm_data:/data
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    stop_grace_period: 30s
secrets:
  ptm_master_key:
    file: ./secrets/master-key
  ptm_bootstrap_token:
    file: ./secrets/bootstrap-token
volumes:
  ptm_data:
```

The README must show secure generation of secret files without terminal disclosure, file permissions compatible with the non-root container, image pull/start steps, local/SSH access, setup, preflight, enabling automation, restart behavior, backup/restore and versioned upgrades. Image names in documentation are examples until published; do not claim a nonexistent image is pullable. No live credentials or payment actions are needed to run the local demo.

## 12. Demo and verification

Include isolated local mock primary and backup origin services and provider/Cloudflare simulators. Provide docker compose --profile demo up --build or an equally simple documented demo command. Demo mode is visibly labeled and uses only local fixtures; it cannot send real provider mutations or real notifications.

Test the following meaningful failure cases:

1. Healthy primary never changes routing.
2. One transient failed probe does not fail over.
3. A backup start is skipped if already running.
4. Unready backup or shared dependency outage never receives an intentional route switch.
5. Duplicate requests/worker restarts do not create conflicting incidents or blindly duplicate writes.
6. Crash after provider accepted start resumes by inspecting actual power state.
7. Crash after route mutation resumes by reading actual records before retrying.
8. Deadline and lease generation survive restart; old actors cannot continue stale local work.
9. Unexpected external route edits require reconciliation.
10. Partial A/AAAA update produces an honest partial/unknown outcome.
11. Recovery of primary does not silently fail back.
12. Public probe returning the wrong origin identity fails verification.
13. Secrets are encrypted at rest and absent from responses/logs; bootstrap claim is single-use.
14. SSRF/redirect/metadata/rebinding protections are exercised.
15. Dry run leaves simulator write counters at zero.
16. Database migration and consistent backup/restore work; missing/wrong key fails closed.
17. Browser reload/disconnection does not stop probes, and state persists after container restart.
18. Login, setup wizard, incident timeline, policy controls and manual failover work in browser tests.

Use unit tests for state-machine decisions and fake-clock deadlines, integration tests for SQLite and adapter HTTP behavior, and Playwright for essential UI flows. Test real Docker builds and readiness when the environment permits. Clearly list checks you could not run. Do not invent test results or guarantee production HA from the demo.

## 13. Completion criteria

Deliver source code, lockfile, migrations, working responsive UI, authenticated API, persistent background worker, real provider adapter implementations, real routing adapter, local simulation, Dockerfile, Compose files, setup/boot documentation, OpenAPI contract, tests and a concise limitations list.

Verify formatting/lint, types, meaningful tests, production build and available Docker smoke checks. Identify external credentials required for live testing separately. Document the controller as a single-instance control plane: if it is down, existing traffic routing continues but no new controller-directed failover happens. Mention that a second independent controller requires a different shared-state/fencing design, not copying SQLite.

Finish with exact local commands, image build/publish commands with placeholders, the setup walkthrough, checks actually run, and remaining limitations. Proceed with the implementation autonomously; use the defaults above for routine choices.

END PROMPT

## References for the implementing AI

Validate current request/response schemas and dependency versions when building:

- Hostinger API: https://developers.hostinger.com/
- Hostinger official SDK endpoint reference: https://github.com/hostinger/api-python-sdk
- AWS EC2 SDK documentation: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/ec2/
- Cloudflare DNS API: https://developers.cloudflare.com/api/resources/dns/subresources/records/
- Cloudflare proxy/TTL behavior: https://developers.cloudflare.com/dns/proxy-status/
- Cloudflare Load Balancing: https://developers.cloudflare.com/load-balancing/
- Docker persistent volumes: https://docs.docker.com/engine/storage/volumes/
- Docker build guidance: https://docs.docker.com/build/building/best-practices/

Prepared 14 October 2026. The Docker Compose above is a specification for the AI to implement and validate with the application; no PTM Failover registry image has been published by this document.
