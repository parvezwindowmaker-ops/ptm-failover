# Prepare the application independently

Provision the primary and backup yourself. Install Docker/systemd ahead of time, pre-pull the same pinned tested image, configure matching application secrets, TLS and durable dependencies, and test capacity. Never rely on downloading source, rebuilding images or running destructive database migrations during an incident.

The controller image is separate from your application image. Generic servers must already be running. AWS/Hostinger start-on-failure starts only an existing prepared stopped resource; boot auto-start must launch the application.

Reference readiness contract:

```json
{
  "status": "ready",
  "serverId": "backup-api-01",
  "release": "2026.10.1",
  "dependencies": { "database": true }
}
```

Use HTTP 200 only when essential dependencies are ready, otherwise 503. Configure the exact expected identity and release independently on each origin. Keep readiness responses out of CDN caches (`Cache-Control: no-store`) and use minimal non-sensitive identifiers. Protect origin access using network/firewall rules appropriate to the controller. The public verification route must expose enough safe identity evidence to distinguish origins, without credentials or diagnostic internals.

For a Node/Fastify backend, register `/ready`, check a lightweight database query with a short timeout, return that JSON structure, and always set no-store. Do not include connection strings, usernames, table data or exception bodies. A generic status-only check can monitor readiness but has visibly weaker validation; this release requires an expected server identity before a reviewed traffic change.

See `examples/managed-application.compose.yaml` and `examples/managed-application.service`. Pre-pull the configured image before an incident. Make the image start automatically at boot. No arbitrary remote shell endpoints are present in PTM Failover.

Customer architecture responsibilities:

- Database HA/replication and data loss objectives; a shared DB on the failed primary defeats origin failover.
- Durable uploads/object storage and replication of any required local files.
- Compatible sessions/authentication keys; in-memory sessions do not move with DNS.
- Singleton/background jobs and workload-specific fencing; both origins may run concurrently.
- WebSocket reconnect/replay from durable messages; existing sockets disconnect.
- Idempotent retries for payments and other writes; an interrupted request may already have committed.

Primary recovery never triggers automatic failback. Review the primary's sustained readiness, exact release, dependencies and current routing before approving manual failback.
