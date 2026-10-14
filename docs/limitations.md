# Scope and limitations

- Single owner, single controller replica, one primary and backup per application. The control plane is not HA. Existing traffic routes survive controller downtime; monitoring and new controller-directed failover do not.
- Controller-owned Cloudflare A/AAAA content switching, already-proxied preferred. DNS-only caching has no universal five-minute recovery guarantee. Paid Cloudflare Load Balancing is unavailable.
- Confirmation is operator-reviewed or explicitly opted-in single vantage. Repeated probes do not prove a provider-wide outage or provide independent regional observations.
- Partial/unknown routing outcomes and external edits require reconciliation. No automatic failback, rollback, primary shutdown, database promotion, VM purchase, reprovisioning, remote shell or workload fencing.
- A readiness identity is required for traffic changes. Public cache-bypass verification plus API readback measures one vantage; it does not prove global convergence.
- Local leases fence stale local work; provider APIs cannot atomically consume controller generations. Remote calls already in flight or a suspended process resuming at a remote-call boundary can still race.
- Current provider contract tests are mocked. Live credentials, prepared origins, route ownership, permissions, API states and TLS must be validated in the deployment environment.
- The demo origin/public services are separate loopback HTTP listeners in the same supervised Node process. They model control decisions, not geographically independent infrastructure or Cloudflare propagation.
- Raw probe queries are bounded and bucketed; aggregates retain 90 days. Incident/audit deletion and offline key rotation are currently operator procedures.
- Arbitrary private probe subnets require operator-approved CIDRs; metadata, link-local and reserved ranges remain blocked. Webhooks support public HTTPS destinations only. Redirects are disabled.
- No team roles, billing, Kubernetes or automatic data migration. The customer owns durable application dependencies, data-loss objectives, session compatibility, file replication, capacity, job fencing and socket reconnect/replay.
