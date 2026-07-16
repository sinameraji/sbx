# sbx

**Self-hostable sandbox infrastructure for AI agents.** Spin up many secure, persistent, observable sandboxes for coding agents (Claude Code, Codex, OpenCode, …) on *your own* hardware — a Mac, an EC2/GCE VM, or bare-metal Linux. No vendor lock-in. CLI-first, with a web dashboard, TypeScript + Python SDKs, and an **egress control plane** that keeps provider API keys out of the sandbox and governs everything an agent can reach.

<img width="1512" height="862" alt="Screenshot 2026-06-18 at 11 42 07" src="https://github.com/user-attachments/assets/621b645e-6305-4287-a7ed-300a5a927df1" />
<img width="726" height="643" alt="Screenshot 2026-06-18 at 11 42 42" src="https://github.com/user-attachments/assets/a0612cc2-8a35-4af7-9633-a09b1262edf3" />

> **Status:** Phases 0–2 complete; Phase 3 (microVM isolation) nearly done. One daemon now runs **three drivers side by side** with per-sandbox selection: the Docker **container** driver (Linux + macOS) with durable state, idle auto-pause/resume, files/processes/sessions, a stateful code interpreter, preview URLs, backups, per-sandbox metrics + cost meter, structured logs + OpenTelemetry traces, API-key auth, a web dashboard with a **live terminal**, and the **egress control plane** below — including **default-deny egress on Linux**; the **Apple Virtualization** microVM driver (macOS, hardware-isolated VMs — full daemon-level parity 10/10, warm pool adopts a pre-booted VM in ~7ms vs ~2.5s cold boot); and the **Firecracker** microVM driver (Linux + KVM) — **live, with full daemon-level parity: the same 10-check end-to-end suite the VZ driver passes (REST → SSE → SDK → preview proxy → backups → persistence) is green on a real x86_64 microVM**. Remaining Phase 3 work: Firecracker snapshots + warm pool, and wiring memory-snapshot pause/resume into the lifecycle FSM.

## The problem it solves for agents

You want to run untrusted agent code at scale, and two things bite immediately:

1. **Credentials.** Put your real `OPENAI_API_KEY` in the sandbox and a prompt injection, a leaked log, or a malicious dependency can read it and walk off with full account access.
2. **Blast radius.** An agent that goes wrong can spend unboundedly, or phone data out to anywhere.

The **egress control plane** (below) is sbx's answer, and the part that matters most if you're running *agents* and not just containers. Everything else follows one design constraint: **launch as many sandboxes as your hardware allows** — one shared daemon, near-zero per-sandbox overhead (metrics come from the container runtime, not a sidecar), Apache-2.0, predictable cost, no lock-in.

## Egress control plane ⭐

A single chokepoint that every outbound byte from a sandbox flows through.

**The real key never enters the sandbox.** Give the daemon your provider keys; each sandbox gets a per-sandbox **token** instead. It points its LLM SDK at the gateway, the daemon swaps the token for the real key on the way out, forwards the call, and meters it. Leak the token and it's worthless — revoke that one, and the real key (plus every other sandbox) is untouched.

```bash
# on the daemon host — keys live here, never in a sandbox:
export SBX_PROVIDER_KEY_OPENROUTER=sk-or-...      # also _OPENAI, _ANTHROPIC, _GOOGLE
node packages/daemon/dist/index.js

# auto-wire a sandbox: OPENAI_BASE_URL + OPENAI_API_KEY (a token) are injected for you
sb run --egress --keep "printenv OPENAI_BASE_URL"   # -> http://host.docker.internal:4752/openai
```

**Per-token policy.** Mint a token scoped to exactly what one agent should be able to do:

```bash
sb egress <id> --spend-cap 5 --models 'gpt-4o,claude-3-5*' --rate-calls 60 --rate-window 1m --ttl 24h
```

- `--spend-cap <usd>` — hard ceiling; the gateway returns **402** once this token's cost reaches it.
- `--models <csv>` — model allowlist (prefix globs ok); a disallowed model → **403**.
- `--providers <csv>` — restrict which providers this token may use → **403**.
- `--rate-calls` / `--rate-tokens` / `--rate-window` — sliding-window rate limit → **429**.
- `--ttl <dur>` — expiry (e.g. `30m`, `24h`); after that the token → **403**.

**Per-sandbox spend ceiling.** A hard cap across *all* of a sandbox's tokens, so even an abused-but-not-yet-revoked token can't exceed it:

```bash
sb run --egress --egress-spend-cap 2 "..."     # this sandbox can never spend > $2 on LLMs
```

**Real cost, every provider.** OpenRouter reports USD inline; for OpenAI / Anthropic / Google the gateway computes it from a built-in model price table (override with `SBX_MODEL_PRICES`). Per-sandbox LLM cost shows up in `sb stats`, the metrics API, and the dashboard, folded into the `$` total.

**Any provider, no code.** Built-ins: `openai`, `anthropic`, `openrouter`, `google`/`gemini`. Add your own — a Cloudflare AI Gateway, Azure OpenAI, a self-hosted endpoint — via env:

```bash
export SBX_PROVIDER_CFOPENAI_BASEURL="https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/openai"
export SBX_PROVIDER_CFOPENAI_AUTHHEADER=authorization
export SBX_PROVIDER_CFOPENAI_FORMAT="Bearer {key}"
export SBX_PROVIDER_KEY_CFOPENAI=sk-...
# sandboxes now reach it at http://<egress>/cfopenai/...
```

**Default-deny egress (Linux).** With `SBX_EGRESS_ENFORCE=true`, a sandbox can reach *only* the gateway and a DNS resolver — everything else is dropped at the host firewall (`DOCKER-USER` iptables on a dedicated bridge). The gateway forwards non-LLM traffic (pip / npm / git / apt) to an **allowlist of hosts** — package registries + source forges by default, filtered by domain/SNI not IP — and denies the rest, logging every denial. So a prompt injection has nowhere to phone home, and `git push`-style exfil to a random host is blocked. Direct calls to LLM providers are denied too, so traffic can't skip key injection.

```bash
# needs the daemon to hold CAP_NET_ADMIN (see "Running on a Linux server")
SBX_EGRESS_ENFORCE=true node packages/daemon/dist/index.js
```

> On **macOS Docker Desktop** the firewall can't be installed (the bridge lives in a VM), so enforcement is **advisory** there — the gateway still works, but a process could route around it. Kernel-enforced lockdown on a Mac is the upcoming Apple VZ microVM driver. The gateway, policy, caps, cost, providers, and allowlist all work on macOS today.

It's an LLM gateway (base-URL rewrite + key injection), not a TLS-MITM proxy — no CA to install in any sandbox. Exposed through REST (`POST/GET /sandboxes/:id/egress-tokens`, `DELETE …/:token`), both SDKs, and the CLI; `npm run check:egress` verifies the whole surface (policy, cost, providers, allowlist, fail-closed) with no Docker required.

## Everything else a sandbox needs

- **Sandboxes** — create / list / stop / start / destroy; `/workspace` on a named volume that survives stop/start and daemon restarts.
- **Exec** — streamed stdout/stderr (SSE), env vars, and persistent **sessions** (a `cd` sticks across commands).
- **Files** — write / read / mkdir / list, plus recursive **watch** (created/modified/deleted).
- **Processes** — detached background processes (list / signal / stream logs) and **wait-for-port**.
- **Preview URLs** — expose a container port at `http://<id>-<port>.localhost:4751/` via an L4 proxy that works even where container IPs aren't reachable (macOS Docker Desktop).
- **Code interpreter** — stateful Python/JavaScript contexts (variables + imports persist across `runCode`).
- **Backups** — snapshot/restore `/workspace` to durable host tarballs (portable across sandboxes).
- **Lifecycle** — idle sandboxes auto-pause after `sleepAfter`; the next operation auto-resumes them (workspace intact). They never self-destroy; destroy is explicit and revokes the sandbox's egress tokens.
- **Resource limits** — hard per-sandbox **memory / CPU / PID** caps (cgroups), per create or as daemon-wide defaults, so one sandbox can't starve the rest.
- **Capacity + admission** — tracks committed memory vs the host budget (auto-detected) and **refuses to over-subscribe** (`create` → 503 when full). Usage-based: idle agents pack densely, busy ones reserve what they use.
- **Metrics + cost** — per-sandbox CPU/mem/net/pids, integrated usage, and a configurable `$` cost meter (LLM cost folded in), with history sparklines in the dashboard.
- **Observability** — structured JSON/pretty logs and OpenTelemetry traces (one span per request; optional OTLP/HTTP export, or `GET /traces`).
- **Live terminal** — a real interactive shell (xterm.js) per sandbox in the dashboard, or `sb terminal <id>`.
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
sb stats <id>                   # CPU/mem/net + accumulated cost (incl. LLM)
sb terminal <id>                # interactive shell in your terminal
```

Open the **web dashboard** at <http://127.0.0.1:4750/> — sandbox list, live CPU/mem/net with sparklines, cost meter, preview links, a live terminal, and create/stop/start/destroy.

`npm run smoke` exercises the whole surface end-to-end against live Docker; `npm run smoke:py` does the same through the Python SDK; `npm run check:egress` unit-tests the egress control plane (no Docker); `npm run smoke:remote` drives a live remote daemon via the SDK.

### TypeScript SDK (`@sbx/sdk`, zero runtime deps)

```ts
import { SbxClient } from "@sbx/sdk";

const client = new SbxClient({ endpoint: "http://127.0.0.1:4750" /*, apiKey */ });

// egress wired + scoped in one call: token holds the policy, sandbox has a hard ceiling
const sandbox = await client.getSandbox(undefined, {
  egress: { spendCapUsd: 5, models: ["gpt-4o"], ttlMs: 24 * 3600_000 },
  egressSpendCapUsd: 10,
});
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

## Run AI agents on sbx

sbx is built to *run agents*, not just containers — a sandbox can come up with a **repo cloned in** (`--repo`), **LLM access wired without keys inside** (`--egress`), **per-token + per-sandbox spend caps**, **resource caps**, and **per-agent cost/observability**.

- **Mastra (first-class):** [`@sbx/mastra`](packages/mastra) is a Mastra `Workspace` sandbox provider — drop `SbxSandbox` in where you'd use `E2BSandbox`/`ModalSandbox` and your agent runs on your own hardware.
- **CLI harnesses:** run **OpenCode / Codex / Claude Code / pi.dev** (or any headless agent) in one command — e.g. [`examples/opencode.sh <repo> "<task>"`](examples/opencode.sh) creates a sandbox, clones the repo, runs OpenCode headless via OpenRouter (your key stays on the daemon), and destroys the sandbox when done.

```ts
import { Agent, Workspace } from "@mastra/core";
import { SbxSandbox } from "@sbx/mastra";

const agent = new Agent({
  name: "coder", model: "openai/gpt-5",
  workspace: new Workspace({ sandbox: new SbxSandbox({ repo: "https://github.com/me/app" }) }),
});
await agent.generate("Add a /health route and run the tests.");
```

See [`examples/`](examples) for runnable agent examples + harness recipes.

## CLI

```
sb run "<cmd>" [--image I] [--keep] [--env K=V,…] [--sleep-after MS] [--egress] [--egress-spend-cap USD]
               [--memory MB] [--cpus N] [--pids N] [--repo URL] [--ref BRANCH] [--setup "cmd"]
sb create [--image I] [--env K=V,…] [--egress] [--egress-spend-cap USD] [--memory MB] [--cpus N] [--pids N] …   # prints id
sb exec <id> "<cmd>" [--session SID] [--cwd DIR] [--env K=V,…]
sb ls | stats <id> | stop <id> | start <id> | rm <id> | capacity | info
sb terminal <id>                       # interactive shell (attach)
sb files <write|read|mkdir|list> …     # file ops
sb watch <id> [path]                   # stream file changes
sb start <id> "<cmd>" | ps <id> | kill <id> <procId> | logs <id> <procId>
sb wait-port <id> <port> | expose <id> <port>
sb session create|ls|rm <id> …         # persistent cwd+env
sb env <id> [K=V …]                    # sandbox env
sb run-code <id> "<code>" [--lang python|javascript]
sb backup <id> | restore <id> <backupId> | backups [<id>]

# egress: mint a token, optionally scoped by policy; list / revoke
sb egress <id> [--list] [--revoke TOKEN]
               [--ttl DUR] [--spend-cap USD] [--models CSV] [--providers CSV]
               [--rate-calls N] [--rate-tokens N] [--rate-window DUR]

Global: --endpoint <url> (SBX_ENDPOINT) · --api-key <key> (SBX_API_KEY)
```

## Configuration (daemon env)

| Var | Default | What |
|---|---|---|
| `SBX_HOST` / `SBX_PORT` | `127.0.0.1` / `4750` | REST API bind |
| `SBX_DRIVER` | `container` | Runtime driver: `container` (Docker) — `firecracker`/`applevz` are Phase 3 |
| `SBX_IMAGE` | `python:3.11-slim-bookworm` | Default sandbox image |
| `SBX_DEFAULT_MEMORY_MB` / `SBX_DEFAULT_CPUS` / `SBX_DEFAULT_PIDS` | `0` (unlimited) | Default per-sandbox hard caps (RAM MiB / fractional cores / process count) |
| `SBX_ADMISSION` | `enforce` | Reject `create` when the host memory budget is exhausted (`off` to only report) |
| `SBX_HOST_MEMORY_MB` / `SBX_HOST_CPUS` | auto-detect | Host capacity budget for admission (defaults to the Docker host's MemTotal/NCPU) |
| `SBX_OVERCOMMIT` / `SBX_DEFAULT_RESERVATION_MB` | `1` / `256` | Memory overcommit factor / admission floor for an uncapped, not-yet-sampled sandbox |
| `SBX_PROXY_PORT` | `4751` | Preview-URL proxy |
| **Egress control plane** | | |
| `SBX_EGRESS_PORT` | `4752` | Egress gateway (`0` disables) |
| `SBX_PROVIDER_KEY_*` | — | Provider keys (`_OPENAI`, `_ANTHROPIC`, `_OPENROUTER`, `_GOOGLE`, or any custom name) |
| `SBX_PROVIDER_<NAME>_BASEURL` / `_AUTHHEADER` / `_FORMAT` | — | Define a custom provider (e.g. a Cloudflare AI Gateway); pair with `SBX_PROVIDER_KEY_<NAME>` |
| `SBX_MODEL_PRICES` | built-in | JSON file overriding the model price table (used to compute cost when a provider doesn't report it) |
| `SBX_EGRESS_SPEND_CAP` | `0` | Default per-sandbox LLM spend ceiling in USD (`0` = unlimited; per-create `egressSpendCapUsd` overrides) |
| `SBX_EGRESS_ENFORCE` | `false` | **Default-deny egress** (Linux): lock sandboxes to the gateway + DNS via host iptables. Needs `CAP_NET_ADMIN`. Advisory on macOS |
| `SBX_EGRESS_NETWORK` / `SBX_EGRESS_SUBNET` | `sbx-egress` / `10.200.0.0/24` | Bridge name / subnet for enforced egress |
| `SBX_EGRESS_DNS` | embedded | Pinned DNS resolver IP under enforcement (blocks DNS exfil; DoH is denied by the allowlist) |
| `SBX_ALLOWLIST_FILE` / `SBX_ALLOWLIST_EXTRA` / `SBX_ALLOW_SOURCE_CONTROL` | defaults / — / `true` | Forward-proxy host allowlist: full override file / extra hosts / include the git-forge tier |
| `SBX_EGRESS_HOST` / `SBX_EGRESS_ADVERTISE_HOST` | `127.0.0.1` / `host.docker.internal` | Gateway bind address / host advertised in egress base URLs |
| **Other** | | |
| `SBX_DB` | `~/.sbx/state.db` | SQLite state (`:memory:` = ephemeral) |
| `SBX_BACKUP_DIR` | `~/.sbx/backups` | Backup tarballs |
| `SBX_SLEEP_AFTER_MS` | `0` | Default idle auto-pause (`0` = off) |
| `SBX_METRICS_INTERVAL_MS` / `SBX_METRICS_HISTORY` | `10000` / `60` | Sampler cadence / sparkline ring |
| `SBX_COST_CPU_PER_HOUR` / `_MEM_GB_PER_HOUR` / `_EGRESS_PER_GB` | `0.05` / `0.005` / `0.01` | Cost-meter rates |
| `SBX_API_KEY` | — | Require this key on the REST API (empty = open, loopback) |
| `SBX_ALLOWED_HOSTS` | — | Extra `Host` values accepted by the API (DNS-rebinding guard; loopback always allowed) |
| `SBX_MAX_BODY_BYTES` | `33554432` | Max request body size before 413 (REST + egress) |
| `SBX_LOG_LEVEL` / `SBX_LOG_FORMAT` | `info` / `pretty` | Logging (`json` for ingestion) |
| `SBX_OTLP_ENDPOINT` | — | OTLP/HTTP traces export (e.g. `http://localhost:4318`) |

## Running on a Linux server (GCP / AWS)

The container driver is the same codepath on macOS and Linux — it talks to the Docker Engine API, not anything host-specific — so a Mac Mini and a GCE/EC2 Linux VM run sbx identically. On a fresh Ubuntu/Debian VM:

```bash
# 1. Docker (native dockerd — the daemon finds /var/run/docker.sock automatically)
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker "$USER"   # re-login

# 2. Node ≥22 (for node:sqlite + global WebSocket), then build
node -v   # must be ≥ 22
npm install && npm run build

# 3. Run the daemon. For remote access, bind a real interface + require a key:
SBX_HOST=0.0.0.0 SBX_API_KEY="$(openssl rand -hex 24)" \
  node packages/daemon/dist/index.js
```

Notes for the egress feature on Linux (auto-handled on macOS Docker Desktop):

- **Gateway reachability.** Sandboxes call back to the daemon via `host.docker.internal`. The daemon maps that name to the bridge gateway for you (`ExtraHosts: host-gateway`), but the gateway must also *bind* somewhere the bridge can reach — loopback isn't. Set **`SBX_EGRESS_HOST=0.0.0.0`** (protected by the per-sandbox token + your VM firewall) if you use `--egress`.
- **Default-deny enforcement** (`SBX_EGRESS_ENFORCE=true`) installs host `DOCKER-USER` iptables, so the daemon needs iptables privileges — run it as root or grant `CAP_NET_ADMIN` (e.g. a systemd unit with `AmbientCapabilities=CAP_NET_ADMIN`). Keep `SBX_EGRESS_ADVERTISE_HOST=host.docker.internal` under enforcement so the proxy + firewall agree on the gateway address. Validated on GCP Ubuntu 24.04.
- **Non-default Docker runtimes** (colima, remote, rootless): export `DOCKER_HOST` — docker-modem honors it. Native `dockerd` and Docker Desktop need nothing.

> **Stronger isolation (microVMs):** the default container driver shares the host kernel. For VM-grade per-sandbox isolation on Linux, the **Firecracker driver** (Phase 3) needs `/dev/kvm` — a bare-metal box or a *nested-virtualization* GCE/EC2 instance. Not built yet (see `docs/plan.md`).

## Security model

sbx is **single-tenant** by design: the API offers arbitrary command execution *inside* sandboxes (that's the point), so anyone who can reach the API controls them. Treat API access as shell access.

- **Bind + auth.** Loopback + auth-off by default. Exposing it on a network? Set `SBX_API_KEY` (constant-time checked; honored by both SDKs, the CLI, and the dashboard) and bind a real interface via `SBX_HOST`.
- **Keys out of the sandbox.** Provider keys live on the daemon; sandboxes get revocable, policy-scoped tokens (see the egress control plane). Combined with `SBX_EGRESS_ENFORCE` on Linux, even a stolen token can't be exfiltrated — there's nowhere to send it.
- **Spend bounds.** Per-token (`--spend-cap`) and per-sandbox (`--egress-spend-cap`) hard ceilings cap LLM cost even if a token is abused before you revoke it.
- **Browser guard.** On a loopback bind, the API rejects requests whose `Host` isn't loopback / `SBX_HOST` / `SBX_ALLOWED_HOSTS` — a DNS-rebinding / localhost-CSRF guard.
- **DoS bounds.** Request bodies are capped (`SBX_MAX_BODY_BYTES`) and WebSocket messages are size-limited.
- **Isolation.** The container driver shares the host kernel; per-sandbox CPU/memory/PID caps are available, but **hardware** isolation comes with the Phase 3 microVM drivers.

## Pre-installing packages / custom setup

The simplest way is the declarative `setup` field — shell commands run once, in order, right after the container starts at create time:

```bash
sb create --setup "npm i kimiflare && pip install ruff"
```
```ts
// SDK: pass an ordered array (each entry runs in sequence)
await client.getSandbox(undefined, { setup: ["npm i kimiflare", "pip install ruff"] });
```

Setup is **best-effort** (a non-zero exit is logged, not fatal) and runs once at create — with persistence (the default) the installed deps live in the workspace volume and survive idle-pause/resume. Other approaches:

1. **Bake a custom image** — extend `images/base/Dockerfile`, then `SBX_IMAGE=my/sbx:latest`. Fastest cold-start; daemon-wide.
2. **Run setup after create** — `id=$(sb create) && sb exec "$id" "npm i kimiflare"`.
3. **Backup/restore templating** — provision once, `sb backup`, then `sb restore` into fresh sandboxes.

> Under default-deny egress, `setup`/install steps reach package registries through the gateway (pypi, npm, crates, go, rubygems, maven, packagist, apt/apk are allowlisted by default). Add private registries with `SBX_ALLOWLIST_EXTRA`.

## Architecture

- **`sbd`** — single control-plane daemon per host: hand-rolled `node:http` REST API + WebSocket, embedded SQLite state, idle reaper, metrics sampler, preview proxy, egress control plane, and a pluggable runtime-driver layer.
- **Runtime drivers** — the core abstraction (`create`/`exec`/`openTerminal`/files/ports/backup/stats/…), selected by `SBX_DRIVER`. Today: `container` (Docker) on Linux + macOS. Next: `firecracker` (Linux) and `applevz` (macOS) microVM drivers behind the same interface (scaffolded; they need a KVM/VZ host), so the daemon/SDKs/CLI are unchanged when you swap isolation tiers.
- **SDKs** — TypeScript + Python, mirroring the Cloudflare Sandbox surface so existing harnesses adopt with near-zero friction.

See `docs/plan.md` for the full spec and phased roadmap, and `KIMI.md` for contributor/agent context.

## Packages

| Package | What |
|---|---|
| `packages/daemon` (`@sbx/daemon`, bin `sbd`) | The control-plane daemon |
| `packages/sdk` (`@sbx/sdk`) | TypeScript client SDK (zero runtime deps) |
| `packages/cli` (`@sbx/cli`, bin `sb`) | Command-line interface |
| `packages/mastra` (`@sbx/mastra`) | Mastra `Workspace` sandbox provider (run Mastra agents on sbx) |
| `sdk/python` (`sbx-sdk`) | Python client SDK (stdlib-only, mirrors the TS SDK) |
| `images/base` | Base sandbox OCI image (Python 3.11 + Node 20 + git/bash) |

## License

Apache-2.0
