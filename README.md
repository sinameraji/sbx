# sbx

**Self-hostable sandbox infrastructure for AI agents.** Spin up many secure, persistent, observable sandboxes for coding agents (Claude Code, Codex, OpenCode, …) on *your own* hardware — a Mac, an EC2/GCE VM, or bare-metal Linux. No vendor lock-in. CLI-first, with a web dashboard, TypeScript + Python SDKs, and an LLM egress gateway.

<img width="1512" height="862" alt="Screenshot 2026-06-18 at 11 42 07" src="https://github.com/user-attachments/assets/621b645e-6305-4287-a7ed-300a5a927df1" />
<img width="726" height="643" alt="Screenshot 2026-06-18 at 11 42 42" src="https://github.com/user-attachments/assets/a0612cc2-8a35-4af7-9633-a09b1262edf3" />

> **Status:** Phases 0–2 complete; Phase 3 started. The Docker container driver works on Linux + macOS with durable state, idle auto-pause/resume, files/processes/sessions, a stateful code interpreter, preview URLs, backups, per-sandbox metrics + cost meter, structured logs + OpenTelemetry traces, API-key auth, a web dashboard with a **live terminal**, and an **egress credential proxy** (LLM gateway). Firecracker (Linux) / Apple Virtualization (macOS) microVM drivers are next and need a KVM-capable host.

## Why

`sbx` brings together what agent workloads need on your own infrastructure: **self-hosted + permissive (Apache-2.0) + isolation-optional + built-in observability & cost visibility + dev-first UX.** Run it on hardware you control, with predictable cost and no vendor lock-in.

Design constraint #1: you should be able to launch *as many* agents/sandboxes as your *hardware* allows — the architecture adds near-zero per-sandbox overhead (one shared daemon; metrics come from the container runtime, not a per-sandbox sidecar).

## Features

- **Sandboxes** — create / list / stop / start / destroy; `/workspace` backed by a named volume that survives stop/start and daemon restarts.
- **Exec** — run commands with streamed stdout/stderr (SSE), env vars, and persistent **sessions** (a `cd` sticks across commands).
- **Files** — write / read / mkdir / list, plus recursive **watch** (created/modified/deleted events).
- **Processes** — start detached background processes, list, signal, and stream their logs; **wait-for-port**.
- **Preview URLs** — expose an in-container port at `http://<id>-<port>.localhost:4751/` via an L4 proxy that works even where container IPs aren't reachable (macOS Docker Desktop).
- **Code interpreter** — stateful Python/JavaScript contexts (Jupyter-style: variables and imports persist across `runCode` calls).
- **Backups** — snapshot/restore `/workspace` to durable host tarballs (portable across sandboxes).
- **Lifecycle** — idle sandboxes auto-pause after `sleepAfter`; the next operation transparently auto-resumes them (workspace intact).
- **Metrics + cost** — per-sandbox CPU/mem/net/pids, integrated CPU-seconds / mem-byte-seconds / egress, and a configurable `$` cost meter. History sparklines in the dashboard.
- **Resource limits** — hard per-sandbox **memory / CPU / PID** caps (cgroups), set per create (`--memory`/`--cpus`/`--pids`, SDK `memoryMb`/`cpus`/`pidsLimit`, or dashboard) or as daemon-wide defaults — so launching many sandboxes bounds them all and one can't starve the rest.
- **Observability** — structured JSON/pretty logs and OpenTelemetry traces (one span per request; optional OTLP/HTTP export, or read recent spans at `GET /traces`).
- **Live terminal** — a real interactive shell (xterm.js) per sandbox in the dashboard, or `sb terminal <id>` from the CLI, over a hand-rolled WebSocket PTY.
- **Egress credential proxy** — an LLM gateway: sandboxes reach OpenAI/Anthropic/OpenRouter with a per-sandbox token instead of a real key; the daemon injects the real key (held host-side), forwards, and meters calls + tokens. Opt-in auto-wiring sets the provider env vars for you.
- **Auth** — optional API key (`SBX_API_KEY`) on the REST API, honored by both SDKs, the CLI, and the dashboard.

## Quick start

Requires a running Docker-compatible runtime (Docker Desktop / colima / Apple `container`).

```bash
npm install
npm run build

# start the daemon (REST on :4750, preview proxy on :4751, egress gateway on :4752)
node packages/daemon/dist/index.js

# in another shell — run a command in a fresh sandbox
sb run "python3 -c 'print(2+2)'"

# create a long-lived sandbox and keep it
sb run --keep "echo ready"      # prints its id; reuse with the commands below
sb stats <id>                   # CPU/mem/net + accumulated cost
sb terminal <id>                # interactive shell in your terminal
```

Open the **web dashboard** at <http://127.0.0.1:4750/> — sandbox list, live CPU/mem/net with sparklines, cost meter, preview links, a live terminal, and create/stop/start/destroy.

`npm run smoke` exercises the whole surface end-to-end against live Docker; `npm run smoke:py` does the same through the Python SDK.

### TypeScript SDK (`@sbx/sdk`, zero runtime deps)

```ts
import { SbxClient } from "@sbx/sdk";

const client = new SbxClient({ endpoint: "http://127.0.0.1:4750" /*, apiKey */ });
const sandbox = await client.getSandbox();
const { stdout } = await sandbox.exec("python3 -c 'print(2+2)'");
await sandbox.writeFile("/workspace/hi.txt", "hello");
await sandbox.destroy();
```

### Python SDK (`sdk/python`, stdlib-only)

```python
from sbx import SbxClient

sandbox = SbxClient().get_sandbox()      # honors SBX_ENDPOINT / SBX_API_KEY
print(sandbox.exec("python3 -c 'print(2+2)'").stdout)   # "4\n"
sandbox.destroy()
```

## Egress credential proxy (LLM gateway)

Give the daemon your provider keys; sandboxes never see them.

```bash
# on the daemon host:
export SBX_PROVIDER_KEY_OPENAI=sk-...        # also _ANTHROPIC, _OPENROUTER
node packages/daemon/dist/index.js

# auto-wire a sandbox: OPENAI_BASE_URL / OPENAI_API_KEY are injected for you
sb run --egress --keep "printenv OPENAI_BASE_URL"
#   -> http://host.docker.internal:4752/openai

# or mint a token explicitly and print the env to set
sb egress <id>
```

Inside the sandbox, point any OpenAI-compatible SDK at the printed base URL using the **egress token** as the API key. The daemon swaps in the real key, forwards the call, and records per-sandbox provider calls + prompt/completion tokens (visible in `sb stats` and the dashboard). It's an LLM gateway (base-URL rewrite), not a TLS-MITM proxy — no CA to install.

## CLI

```
sb run "<cmd>" [--image I] [--keep] [--env K=V,…] [--sleep-after MS] [--egress] [--memory MB] [--cpus N] [--pids N]
sb create [--image I] [--env K=V,…] [--sleep-after MS] [--egress] [--memory MB] [--cpus N] [--pids N]   # standalone sandbox, prints id
sb exec <id> "<cmd>" [--session SID] [--cwd DIR] [--env K=V,…]
sb ls | stats <id> | stop <id> | start <id> | rm <id>
sb terminal <id>                       # interactive shell (attach)
sb files <write|read|mkdir|list> …     # file ops
sb watch <id> [path]                   # stream file changes
sb start <id> "<cmd>" | ps <id> | kill <id> <procId> | logs <id> <procId>
sb wait-port <id> <port> | expose <id> <port>
sb session create|ls|rm <id> …         # persistent cwd+env
sb env <id> [K=V …]                    # sandbox env
sb run-code <id> "<code>" [--lang python|javascript]
sb backup <id> | restore <id> <backupId> | backups [<id>]
sb egress <id> [--list] [--revoke TOKEN]

Global: --endpoint <url> (SBX_ENDPOINT) · --api-key <key> (SBX_API_KEY)
```

## Configuration (daemon env)

| Var | Default | What |
|---|---|---|
| `SBX_HOST` / `SBX_PORT` | `127.0.0.1` / `4750` | REST API bind |
| `SBX_DRIVER` | `container` | Runtime driver: `container` (Docker) — `firecracker`/`applevz` are Phase 3 |
| `SBX_IMAGE` | `python:3.11-slim-bookworm` | Default sandbox image |
| `SBX_DEFAULT_MEMORY_MB` / `SBX_DEFAULT_CPUS` / `SBX_DEFAULT_PIDS` | `0` (unlimited) | Default per-sandbox hard caps (RAM MiB / fractional cores / process count) |
| `SBX_PROXY_PORT` | `4751` | Preview-URL proxy |
| `SBX_EGRESS_PORT` | `4752` | Egress gateway (`0` disables) |
| `SBX_PROVIDER_KEY_*` | — | Provider keys (`_OPENAI`, `_ANTHROPIC`, `_OPENROUTER`) |
| `SBX_EGRESS_ADVERTISE_HOST` | `host.docker.internal` | Host advertised in egress base URLs |
| `SBX_DB` | `~/.sbx/state.db` | SQLite state (`:memory:` = ephemeral) |
| `SBX_BACKUP_DIR` | `~/.sbx/backups` | Backup tarballs |
| `SBX_SLEEP_AFTER_MS` | `0` | Default idle auto-pause (`0` = off) |
| `SBX_METRICS_INTERVAL_MS` / `SBX_METRICS_HISTORY` | `10000` / `60` | Sampler cadence / sparkline ring |
| `SBX_COST_CPU_PER_HOUR` / `_MEM_GB_PER_HOUR` / `_EGRESS_PER_GB` | `0.05` / `0.005` / `0.01` | Cost rates |
| `SBX_API_KEY` | — | Require this key on the REST API (empty = open, loopback) |
| `SBX_ALLOWED_HOSTS` | — | Extra `Host` values accepted by the API (DNS-rebinding guard; loopback always allowed) |
| `SBX_MAX_BODY_BYTES` | `33554432` | Max request body size before 413 (REST + egress) |
| `SBX_LOG_LEVEL` / `SBX_LOG_FORMAT` | `info` / `pretty` | Logging (`json` for ingestion) |
| `SBX_OTLP_ENDPOINT` | — | OTLP/HTTP traces export (e.g. `http://localhost:4318`) |

## Security model

sbx is **single-tenant** by design: the API offers arbitrary command execution *inside* sandboxes (that's the point), so anyone who can reach the API controls the sandboxes. Treat API access as you would shell access.

- **Bind + auth.** Binds **loopback** by default with auth off. Exposing it on a network? Set `SBX_API_KEY` (constant-time checked; honored by both SDKs, the CLI, and the dashboard) and bind a real interface via `SBX_HOST`.
- **Browser guard.** On a loopback bind, the API rejects requests whose `Host` isn't loopback / `SBX_HOST` / `SBX_ALLOWED_HOSTS` — a DNS-rebinding / localhost-CSRF guard so a website you visit can't drive the daemon.
- **DoS bounds.** Request bodies are capped (`SBX_MAX_BODY_BYTES`) and WebSocket messages are size-limited.
- **Isolation.** The container driver shares the host kernel; per-sandbox CPU/memory/PID caps are available (above) but **hardware** isolation comes with the Phase 3 microVM drivers.

## Pre-installing packages / custom setup

The simplest way is the declarative `setup` field — shell commands run once, in order, right after the container starts at create time:

```bash
sb create --setup "npm i kimiflare && pip install ruff"
```
```ts
// SDK: pass an ordered array (each entry runs in sequence)
await client.getSandbox(undefined, { setup: ["npm i kimiflare", "pip install ruff"] });
```

Setup is **best-effort**: a non-zero exit is logged on the daemon but does **not** fail create. It runs once at create — with persistence (the default) the installed deps live in the workspace volume and survive idle-pause/resume, so they are not re-run. Prefer baking a custom image when the same setup applies to every sandbox (faster cold-start, no per-create cost).

Other approaches:

1. **Bake a custom image** — extend `images/base/Dockerfile` with your installs and point the daemon at it. Fastest cold-start; applies daemon-wide.
   ```dockerfile
   FROM sbx/base:latest
   RUN pip install kimiflare && npm i -g some-tool
   ```
   ```bash
   docker build images/base -t my/sbx:latest
   SBX_IMAGE=my/sbx:latest node packages/daemon/dist/index.js
   ```
2. **Run setup after create** — per-sandbox, imperative:
   ```bash
   id=$(sb create) && sb exec "$id" "npm i kimiflare"
   # or, for a throwaway run:
   sb run --keep "npm i kimiflare && node app.js"
   ```
3. **Backup/restore templating** — provision once, snapshot, then restore into fresh sandboxes:
   ```bash
   sb exec <id> "npm i kimiflare"     # provision a template sandbox
   sb backup <id>                     # -> <backupId>
   sb restore <newId> <backupId>      # new sandbox starts pre-provisioned
   ```

## Architecture

- **`sbd`** — single control-plane daemon per host: hand-rolled `node:http` REST API + WebSocket, embedded SQLite state, idle reaper, metrics sampler, preview proxy, egress gateway, and a pluggable runtime-driver layer.
- **Runtime drivers** — the core abstraction (`create`/`exec`/`openTerminal`/files/ports/backup/stats/…), selected by `SBX_DRIVER`. Today: `container` (Docker) on Linux + macOS. Next: `firecracker` (Linux) and `applevz` (macOS) microVM drivers behind the same interface (scaffolded; they need a KVM/VZ host), so the daemon/SDKs/CLI are unchanged when you swap isolation tiers.
- **SDKs** — TypeScript + Python, mirroring the Cloudflare Sandbox surface so existing harnesses adopt with near-zero friction.

See `docs/plan.md` for the full spec and phased roadmap, and `KIMI.md` for contributor/agent context.

## Packages

| Package | What |
|---|---|
| `packages/daemon` (`@sbx/daemon`, bin `sbd`) | The control-plane daemon |
| `packages/sdk` (`@sbx/sdk`) | TypeScript client SDK (zero runtime deps) |
| `packages/cli` (`@sbx/cli`, bin `sb`) | Command-line interface |
| `sdk/python` (`sbx-sdk`) | Python client SDK (stdlib-only, mirrors the TS SDK) |
| `images/base` | Base sandbox OCI image (Python 3.11 + Node 20 + git/bash) |

## License

Apache-2.0
