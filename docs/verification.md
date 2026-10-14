# Verification record

Verified on 14 October 2026 with Node.js 24.15.0 on Windows. Package versions are pinned; pnpm 12.11.2 installed the frozen lockfile in an isolated clean workspace. The same source was copied there to avoid files locked by previously interrupted dependency installations. Production build artifacts were copied back to `controller/`.

| Check | Result |
| --- | --- |
| TypeScript 7 type checking | Passed |
| ESLint | Passed |
| Vitest | 43 tests passed across security, persistence, orchestration and provider/routing adapters |
| Independent Node security/core suite | 19 tests passed, using real Node SQLite for the dependency-independent persistence checks |
| Vite production frontend and bundled Node API | Passed |
| Prettier | Passed |
| Chromium end-to-end recovery | Passed: claim, ten-step setup, preflight, reload, simulated failure, reviewed failover, verified incident, themes and login/logout |
| Local workspace demo smoke | `/`, session, liveness and readiness returned HTTP 200 on port 8080 |

The Vitest persistence tests use the production `better-sqlite3` driver. The independent suite additionally checks authenticated encryption, idempotency, restart recovery decisions, absolute deadlines, stale generations, partial/external routing changes, backup/reopen and sanitized provider errors. Provider HTTP/SDK requests in these tests are mocked; their passing results do not establish live provider availability.

Desktop light/dark and mobile screenshots are produced by the browser test. The mobile test checks that the page stays within the viewport while tables scroll within their containers. Production builds currently emit a frontend bundle-size advisory; code splitting is a future performance improvement.

## Local dependency installation issue

Some files in this host's original generated `node_modules` and package cache remain locked after interrupted installations. This is why full verification used a fresh temporary workspace. The compiled demo in `controller/` was started successfully using the installed native modules. If source-based development commands hang on this machine, close stale project installers/Node processes and restore a clean dependency install; use a fresh checkout if Windows retains the locks. Do not delete application data or secret files while repairing dependencies.

TypeScript 7 provides the compiler; the pinned TypeScript 6 compatibility API supplies ESLint's required compiler API. This follows [Microsoft's side-by-side installation approach](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

## Required external checks

Live AWS/Hostinger inspect/start and Cloudflare read/patch/public recovery require dedicated credentials and prepared existing resources. A traffic-affecting operational drill needs a separately reviewed plan. Test proxy cache behavior, readiness identity, stable IPs and shared durable dependencies on the customer's actual infrastructure.

Docker is not installed on this host. The Dockerfile and Compose manifests are provided, but Linux image builds, container startup, architecture support and upgrade smoke tests were not executed. Verify linux/amd64 and linux/arm64 before publishing an image. No image was published and no live provider mutation was performed.
