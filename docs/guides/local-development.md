# Local development and IDEA debugging

Open the repository root in IDEA. Use the existing Node.js 22+ interpreter and
pnpm 10 installation. Install locked dependencies and run `pnpm build` once if
workspace packages have not been built yet.

## IDEA

The shared `.run` configurations use project-relative paths and do not contain
credentials or agent definitions:

1. Run or Debug **Control Plane API (isolated)**.
2. Run **Control Plane Web (local)**.
3. Open <http://127.0.0.1:5173>; API health is <http://127.0.0.1:3000/health>.

The API configuration executes TypeScript through `--import tsx`. Source
breakpoints work in `apps/server/src`; the API's SQLite database, artifacts and
workspaces are isolated under `.data/idea`. It starts with no registered agents
and makes no model requests by itself. Web uses Vite's normal development server
and hot updates. Both services bind only to the local loopback address.

If a required port is already occupied, identify your existing service first;
do not stop unrelated processes. Stop only the configurations you started.

## Terminal

From the repository root, start the API with an explicit isolated data path:

```powershell
$env:CONTROL_PLANE_DB = "$PWD/.data/terminal/control-plane.sqlite"
pnpm dev:server
```

In another terminal at the repository root:

```powershell
pnpm dev:web
```

The API uses `tsx watch`; Web uses Vite hot updates. Changes to shared
`packages/*` are consumed from their compiled `dist` exports: rebuild the changed
package and its dependants with the existing build scripts. The IDEA API debug
configuration does not watch; restart it after server source changes.

For terminal source debugging, use the same isolated database variable and run
`node --inspect=127.0.0.1:9229 --import tsx apps/server/src/main.ts` instead of
`pnpm dev:server`, then attach the IDE to that loopback debugger.

## Focused validation

Use the repository's pinned pnpm **10.11.0**. Check `pnpm --version` and, on Windows,
`Get-Command pnpm` when an IDE or host supplies a different package manager. The host's
bundled pnpm 11 is not the version verified for this project; do not let it replace the
existing dependency tree merely to run a script. A verified existing pnpm 10 installation
can run the normal repository commands without changing global configuration. The final
R6 baseline passed `pnpm lint`, `pnpm typecheck`, `pnpm test` (425 cases) and `pnpm build`.

The console's “开始协作” panel guides a new project through Agent registration, Boss
selection, explicit connection checks and goal entry. Existing entries can change Boss
eligibility under “Boss 资格与协作权限”; enabling eligibility does not automatically grant
orchestration scope or select that Agent for a project. Removing eligibility also removes
the orchestration scope in the same settings update.

Connection checks invoke ACP initialize only, never a model prompt. Their observations
become unknown after restart or configuration changes. Worker discovery additionally
requires the observed authentication state to be ready or not_reported; the latter is not
proof of successful model authentication. The setup panel is guidance, not a replacement
for execution-time workspace and policy checks.

Stop your own API/Web sessions before the browser check: it starts dedicated
services on ports 3000 and 4173 and defaults to a fresh temporary data directory.
If setting `CONTROL_PLANE_E2E_DATA_DIR`, choose a new dedicated directory for each run.
The default suite uses deterministic local catalog metadata; `pnpm test:e2e:live`
checks the public official catalog separately.

```powershell
pnpm exec prettier --check apps/web/vite.config.ts tests/e2e/local-api.e2e.ts
pnpm --filter @control-plane/web typecheck
pnpm exec playwright test tests/e2e/local-api.e2e.ts
```

This browser regression uses the actual Vite proxy and local API, creates a
project through the UI, checks it after refresh, and checks rejected foreign
Origin/Host/cross-site requests. It does not launch agents or call a model.

Registering and probing deterministic repository ACP fixtures is separate from
configuring a real agent. Real adapter authentication and paid model usage still
require the corresponding explicit authorization.
