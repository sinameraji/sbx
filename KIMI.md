# KIMI.md — sbx Project Context

> Generated context for AI agents working in this repository. Verify assumptions before relying on them; the project is an early MVP and changes quickly.

---

## 1. Project

**sbx** is a self-hostable sandbox infrastructure for AI coding agents. It lets you spin up many secure, persistent, observable sandboxes on your own hardware (Mac, Linux VM, bare metal) instead of using managed cloud sandboxes.

- **Language / runtime:** TypeScript, Node.js ≥20, ES modules (`"type": "module"`)
- **Package manager:** npm with workspaces
- **License:** Apache-2.0
- **Key frameworks / libraries:** `dockerode` (Docker Engine API), `tsx` (dev runner), native `node:http` + `fetch`

Current status: **Phase 0 vertical slice**. The container driver works on Linux and macOS; microVM drivers (Firecracker / Apple VZ) are planned.

---

## 2. Build / test / run

All commands run from the repository root unless noted.

| Command | What it does | Notes |
|---|---|---|
| `npm install` | Install workspace dependencies | Required first step |
| `npm run build` | Compile all workspaces (`tsc`) | Writes to `packages/*/dist/` |
| `npm run dev:daemon` | Run daemon in watch mode with `tsx` | Fast feedback; does not rebuild `dist/` |
| `node packages/daemon/dist/index.js` | Start compiled daemon | Or `sbd` via `node_modules/.bin` |
| `npm run smoke` | Build + run `packages/daemon/dist/smoke.js` | End-to-end create → exec → destroy |
| `npm run dev:cli` | Run CLI in watch mode with `tsx` | Fast feedback; does not rebuild `dist/` |
| `sb run "<cmd>"` | Create a sandbox, run a command, destroy it | Via `node_modules/.bin/sb` after build |

There are **no test, lint, or format scripts** yet. Type-checking is performed by `tsc` during `npm run build`.

### Running the daemon locally

1. Ensure Docker (or colima / Apple `container`) is running.
2. `npm install && npm run build`
3. `node packages/daemon/dist/index.js`
4. Daemon listens on `http://127.0.0.1:4750` by default.

Environment variables (`packages/daemon/src/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `SBX_HOST` | `127.0.0.1` | Bind address |
| `SBX_PORT` | `4750` | Bind port |
| `SBX_IMAGE` | `python:3.11-slim-bookworm` | Default sandbox image |
| `SBX_ENDPOINT` | `http://127.0.0.1:4750` | SDK default endpoint |

---

## 3. Layout

| Path | Rationale |
|---|---|
| `packages/daemon/` | Control-plane daemon (`sbd`). Owns the REST API, sandbox store, and runtime-driver abstraction. |
| `packages/sdk/` | TypeScript client SDK (`@sbx/sdk`). Thin HTTP client that mirrors the Cloudflare Sandbox surface. |
| `packages/cli/` | `sb` CLI. Commands: `run`, `ls`, `rm`. Uses `@sbx/sdk` to talk to the daemon. |
| `images/base/` | OCI image definition for the richer sandbox workspace (Python 3.11 + Node 20 + git/bash). |
| `docs/plan.md` | Long-form product/architecture spec and phased build plan. |
| `tsconfig.base.json` | Shared strict TypeScript config extended by every workspace. |

### Daemon source organization

| Path | Responsibility |
|---|---|
| `src/index.ts` | Entry point: loads config, pings Docker, starts HTTP server. |
| `src/api/server.ts` | Hand-rolled `node:http` REST server (Phase 0 endpoints). |
| `src/driver/` | Runtime-driver interface (`types.ts`) and container implementation (`container.ts`). |
| `src/store.ts` | In-memory sandbox registry (placeholder for SQLite in Phase 1). |
| `src/config.ts` | Environment-driven configuration. |
| `src/types.ts` | Shared daemon types. |

---

## 4. Conventions

### Code style

- **ES modules only.** Every workspace has `"type": "module"`.
- **Import style:** explicit relative imports with `.js` extension, e.g. `import { loadConfig } from "./config.js"`. Required by `NodeNext` module resolution.
- **Node built-ins:** prefix with `node:`, e.g. `import { createServer } from "node:http"`.
- **Export style:** named `export` declarations; no `module.exports`.
- **Naming:** `PascalCase` for classes/interfaces/types, `camelCase` for functions/variables, `kebab-case` for files.

### TypeScript

- `tsconfig.base.json` enables `strict`, `forceConsistentCasingInFileNames`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`.
- Each workspace extends the base config and sets `outDir: dist`, `rootDir: src`.
- The SDK additionally includes `DOM` lib because it parses `ReadableStream` from `fetch` responses.

### Git

- **Commit style:** conventional prefixes observed: `scaffold:`, `daemon:`, `docs:`.
- **Branching:** single `main` branch; no feature branches observed in history.

### Testing

- **No tests exist yet.** There is no test runner, no test scripts, and no `*.test.ts` / `*.spec.ts` files.

### Docker / images

- The daemon requires a running Docker-compatible runtime.
- Default sandbox image is `python:3.11-slim-bookworm` so the vertical slice works without building images.
- Build `images/base/Dockerfile` and set `SBX_IMAGE=sbx/base:latest` for the richer toolset.

---

## 5. Dependencies

### Adding dependencies

```bash
# Runtime dependency in a workspace
npm install <pkg> --workspace @sbx/daemon

# Dev dependency in a workspace
npm install <pkg> --workspace @sbx/daemon --save-dev

# Root dev dependency (e.g. shared tooling)
npm install <pkg> --save-dev
```

### Conventions

- Keep the daemon lightweight; avoid heavy frameworks. Current daemon uses only `dockerode` plus Node built-ins.
- The SDK has **zero runtime dependencies** today — keep it that way if possible.
- Native / external dependencies that must stay external:
  - `dockerode` and `@types/dockerode` (Docker Engine API client)
  - TypeScript toolchain (`typescript`, `tsx`, `@types/node`)
- Version pinning: `package.json` uses caret ranges; `package-lock.json` locks exact versions. Commit `package-lock.json` changes.

---

## 6. Do / Don't

1. **Do not commit secrets.** `.gitignore` excludes `.env`, `.env.*`, and `.sbx/`.
2. **Do not use CommonJS.** All packages are ES modules.
3. **Do not drop the `.js` extension** from relative TypeScript imports — `NodeNext` resolution requires it.
4. **Do not add a heavy web framework** to the daemon without discussion; the Phase 0 server is intentionally hand-rolled.
5. **CLI exists.** `packages/cli` implements `sb run`, `sb ls`, and `sb rm`.
6. **Do not run the smoke script as a correctness check** until `packages/daemon/dist/smoke.js` (or `src/smoke.ts`) is added.
7. **Do keep the SDK dependency-free** unless there is a strong reason to add a runtime dependency.
8. **Do update `docs/plan.md`** when architectural decisions change; it is the source of truth for the phased roadmap.

---

## 7. Debugging & Troubleshooting

### Daemon fails to start

- Error: `container runtime (Docker) is not reachable`
  - Fix: start Docker Desktop, colima, or an Apple `container` daemon.

### Build issues

- `Cannot find module './foo.js'` — ensure the import includes the `.js` extension.
- `Cannot use import statement outside a module` — verify the package has `"type": "module"`.

### Reset / clean

```bash
rm -rf node_modules packages/*/dist
npm install
npm run build
```

### Logs

- The daemon logs to stdout/stderr only. There is no log file yet.
- Container exec output is streamed via Server-Sent Events (`/sandboxes/:id/exec`).

---

## 8. Architecture Notes

### Key abstractions

- **`Driver` interface** (`packages/daemon/src/driver/types.ts`): the runtime boundary. Future Firecracker / Apple VZ drivers implement this same surface so the API and SDK stay unchanged.
- **`ContainerDriver`**: backs sandboxes with long-lived Docker containers. The container stays alive (`sleep infinity`) and the daemon `exec`s into it on demand.
- **`SandboxStore`**: in-memory registry. It will be replaced with embedded SQLite + a lifecycle FSM in Phase 1.
- **`SbxClient` / `Sandbox`**: SDK classes that expose `getSandbox`, `exec`, `execStream`, `destroy`, matching the Cloudflare Sandbox shape.

### Data flow

1. Client calls SDK method.
2. SDK hits daemon REST endpoint.
3. Daemon looks up sandbox in `SandboxStore`.
4. Daemon invokes `Driver.exec` (currently Docker exec).
5. Output streams back as SSE and is parsed by the SDK into `ExecEvent`s.

### External integrations

- Docker Engine API via `dockerode`.
- OCI images from Docker Hub by default; custom base image in `images/base/`.

### State management

- Daemon state is currently in-memory only and is lost on restart.
- Per-sandbox metadata: `id`, `image`, `status`, `createdAt`, `labels`.

---

*Last updated: 2026-06-15*
