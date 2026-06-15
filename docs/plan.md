# Self-Hostable Agent Sandbox Platform — Build Plan (MVP Spec)

## Context

**Goal:** Build a standalone, self-hostable alternative to Cloudflare's Sandbox SDK — infrastructure that lets any engineer spin up secure, persistent, observable sandboxes for AI agents (Claude Code, Codex, OpenCode, etc.) on their own hardware: a Mac Mini/MacBook, an EC2/GCE VM, or a bare-metal Linux box. No Cloudflare hardware, no vendor lock-in. CLI-first, with a web dashboard. Developer-friendly install.

**Why now (market gap, from research):** The managed players (E2B, Modal, Vercel Sandbox, Cloudflare, Blaxel, Fly Sprites) are all closed/cloud-only — you can't run them on your own box for cost or compliance reasons, and bills are unpredictable at scale ($7k–$35k/mo at 200 concurrent sandboxes). The self-hostable options split badly: Daytona is AGPL (commercial friction) and uses weak Docker-shared-kernel isolation; Arrakis/Microsandbox are immature, with minimal observability and no real ops story. Nobody offers the combination of: self-hosted + permissive license + strong-isolation-optional + built-in observability and cost visibility + dev-first UX (CLI + SDK + web UI). That's the wedge.

**The defining constraint (user):** Users must be able to launch many agents in many sandboxes simultaneously, limited only by their own hardware — the architecture must add near-zero per-sandbox overhead. This is the primary design driver and is addressed head-on in the "Density / Lightweight" section below.

**Scoping decisions (confirmed with user):**
- Both Linux and macOS first-class from day one → runtime-driver abstraction; the first driver (OCI container) covers both OSes with one codepath.
- Single-tenant threat model for MVP (operator runs their own agents) → default to the lightest isolation mode; hardening (microVMs, egress controls) is an opt-in upgrade, not a blocker.
- Open-core business model → permissive (Apache-2.0) self-hostable core; paid managed cloud / multi-node / SSO / support later. Deliberately avoids Daytona's AGPL friction.
- Deliverable = buildable MVP spec → concrete architecture + phased plan starting with a thin vertical slice.

**Feasibility verdict:** Highly feasible. Every primitive is proven, open, and documented (Firecracker, containerd, Apple container, Caddy on-demand TLS, cgroups v2, vsock, CRIU/FC-snapshots). The work is integration + DX + observability, not novel systems research. A small team can ship a compelling vertical slice in ~2 weeks and an open-core MVP in ~2–3 months.

---

## Target Architecture

One self-contained control-plane daemon per host, a tiny in-sandbox agent, and thin client SDKs/CLI/UI on top. Single binary, embedded SQLite, no external dependencies to run on one node.

```
   Clients:  TS SDK   Python SDK   `sb` CLI   Web Dashboard
                 \        |           |          /
                  \       |           |         /
                   ▼      ▼           ▼        ▼
        ┌──────────────────────────────────────────────┐
        │   CONTROL-PLANE DAEMON  (single Go binary)    │
        │  • REST + WebSocket/gRPC API (Sandbox surface)│
        │  • Scheduler + warm pool + lifecycle FSM      │
        │  • Embedded reverse proxy (preview URLs, TLS) │
        │  • Metrics + cost meter + OTel exporter       │
        │  • Auth (API keys), embedded SQLite state     │
        │  • Runtime-driver interface ▼                 │
        └───────────────┬──────────────┬───────────────┘
            container driver       microVM driver
         (containerd/Apple    (Firecracker on Linux,
          container — MVP)     Apple VZ on macOS — phase 3)
                 │                      │
            ┌────▼────┐            ┌────▼────┐
            │ sandbox │  ........  │ sandbox │   each runs a tiny
            │ +agent  │            │ +agent  │   in-sandbox agent
            └─────────┘            └─────────┘   (vsock / unix sock)
```

### Components

1. **Control-plane daemon (Go)** — the whole product on one node. Exposes the Sandbox API, schedules sandboxes onto a runtime driver, enforces cgroup limits, runs the preview-URL proxy, collects metrics, holds state in embedded SQLite. Cross-compiles to Linux + macOS, ships as one static binary.
2. **Runtime-driver interface** — the key abstraction. One Go interface (`Create` / `Exec` / `Attach` / `WriteFile` / `ExposePort` / `Snapshot` / `Destroy`) with pluggable implementations:
   - **container driver (MVP, both OSes):** containerd/runc on Linux, Apple container (or Docker/colima fallback) on macOS. Maximum density, lightest weight, single codepath across both hosts.
   - **firecracker driver (phase 3, Linux):** microVM hardware isolation, FC snapshots, vsock transport. Uses firecracker-go-sdk.
   - **applevz driver (phase 3, macOS):** Apple Virtualization.framework for VM-grade isolation on Mac.
   - Single-tenant MVP defaults to container; users flip a flag for microVM isolation.
3. **In-sandbox agent (Go static binary, ~a few hundred LOC; Rust optional later for size)** — runs as PID 1 / sidecar inside each sandbox. Speaks a small protocol over unix socket (container) or vsock (microVM): spawn process, stream stdout/stderr, stdin, file read/write/mkdir/watch (inotify), port-ready detection (`waitForPort`), log-pattern wait. This is the only per-sandbox overhead we add — keep it tiny and statically linked. This is what makes "hardware is the only limit" true.
4. **Client SDKs (TypeScript + Python)** — thin clients over the REST/WS API. Mirror the Cloudflare surface so existing harnesses adopt with near-zero friction: `getSandbox()`, `exec()`, `execStream()`, `runCode()` + `createCodeContext()`, `writeFile`/`readFile`/`mkdir`/`listFiles`, `startProcess()` + `waitForPort()`, `exposePort()`, `createSession()`, `setEnvVars()`, `watch()`, `createBackup`/`restoreBackup`, `destroy()`. API-compatibility is a deliberate moat ("drop-in, but on your own box").
5. **CLI (`sb`)** — single binary, also embeds the daemon. `sb up` (start daemon), `sb run "<cmd>"`, `sb ls`, `sb logs/exec/attach`, `sb expose <port>`, `sb snapshot`, `sb rm`. Install via `curl | sh` / Homebrew.
6. **Web dashboard (React, embedded in the daemon binary)** — list sandboxes; live terminal (xterm.js over WS); per-sandbox CPU/mem/disk/net; live cost meter; preview-URL links; kill/snapshot. Observability + cost visibility built in is a top-3 differentiator from the research.
7. **Preview-URL proxy** — embedded reverse proxy with wildcard routing: `<id>.localhost` locally; `*.sandbox.<yourdomain>` with Caddy on-demand TLS (libraries: Caddy/certmagic) for remote hosts. Token-protected per port (mirrors Cloudflare's port tokens).
8. **Egress credential proxy (phase 3)** — outbound proxy that injects provider API keys so agents reach any LLM provider (OpenAI, Anthropic, Vercel AI SDK, Cloudflare AI Gateway, OpenRouter) without keys baked into the sandbox, and optionally logs provider calls for cost/observability. Provider-agnostic: the sandbox runs the harness; we secure + observe its egress.

### Density / Lightweight design (the core requirement)

- One shared daemon, not per-sandbox sidecars. All metrics come from reading cgroup v2 files (`cpu.stat`, `memory.current`, `io.stat`) + veth counters — no per-sandbox Prometheus/agent process. cAdvisor-style collection in-process.
- Tiny in-sandbox agent is the only added per-sandbox process; static, low-MB RSS.
- Container driver default for single-tenant = shared kernel = thousands per host; microVM is the opt-in when isolation > density.
- Warm pool of pre-booted sandboxes for instant acquire; snapshot/restore (FC snapshots ~5–30ms resume; container checkpoint via CRIU; or copy-on-write volume snapshots on btrfs/zfs) for cheap hibernate→resume.
- Lazy start + idle FSM: `created → running → idle → paused(snapshot) → destroyed`, with configurable `sleepAfter`. Idle sandboxes cost only disk.
- Explicit overhead budget surfaced in the UI: "platform overhead = daemon + N×agent"; everything else is the user's workload.

---

## Repository Structure (to create — greenfield, no existing code)

```
/cmd/sbd            daemon entrypoint
/cmd/sb             CLI entrypoint
/internal/api       REST + WS handlers (Sandbox surface)
/internal/driver    runtime-driver interface + container/firecracker/applevz impls
/internal/agent     in-sandbox agent (separate static binary target)
/internal/proxy     preview-URL reverse proxy + on-demand TLS
/internal/metrics   cgroup/veth collection, cost meter, OTel exporter
/internal/store     SQLite state + lifecycle FSM
/internal/scheduler warm pool, placement, cgroup limits
/sdk/typescript     npm package (mirrors Cloudflare surface)
/sdk/python         pip package
/web                React dashboard (embedded via go:embed)
/images             base sandbox OCI image (Python 3.11, Node 20, git, bash)
```

---

## Phased Build Plan

### Phase 0 — Vertical slice (≈1–2 weeks) — prove the spine end-to-end

**Status: in progress.**

- [x] Daemon with container driver. Implemented using Docker via `dockerode`; works on Linux and macOS. The original plan called for containerd/Apple container — Docker was chosen for the vertical slice because it is the most widely available runtime on developer machines.
- [ ] In-sandbox agent over unix socket: spawn + stream stdout/stderr. **Not implemented.** The daemon currently `exec`s directly into containers. A dedicated agent is deferred until the microVM drivers in Phase 3 require it, or until file/port operations in Phase 1 make a sidecar cleaner.
- [x] REST: `POST /sandboxes`, `POST /sandboxes/{id}/exec` (SSE stream), `DELETE /sandboxes/{id}`.
- [x] TS SDK: `getSandbox()`, `exec()`, `execStream()`.
- [x] `sb run` CLI. Also added `sb ls` and `sb rm` for basic ops.
- [x] Acceptance: `npm run smoke` exercises create → exec → write/read/list/mkdir → destroy locally. Multi-OS/harness validation is still pending.

### Phase 1 — Core sandbox API

**Status: complete.** All Phase 1 capabilities are implemented across the `Driver` → REST → SDK → CLI layering and exercised end-to-end by `npm run smoke`. The remaining known gap before Phase 2 is durable control-plane state: the in-memory `SandboxStore` still loses sandbox/process/session/context records on daemon restart (workspace data and backups already persist on disk). SQLite-backed state + the full lifecycle FSM are the natural lead-in to Phase 2.

- [x] Files (`writeFile`/`readFile`/`mkdir`/`listFiles`) implemented via the container driver and exposed through REST, SDK, and CLI.
- [x] `watch` file changes. Streams `created`/`modified`/`deleted` events for a path over SSE. **Decision:** a portable poll-based watcher in `python3` (guaranteed in the base image; avoids an inotify-tools dependency) runs as a persistent in-container `exec` and diffs recursive mtime snapshots, printing `<type>\t<path>` lines that the daemon relays as SSE events; the in-container watcher is aborted when the client disconnects. A leading SSE comment flushes response headers immediately so a `fetch` client gets the response before the first (possibly far-off) change event — without it, awaiting the response before triggering a change deadlocks. Exposed through the `Driver` (`watchFiles`), REST (`GET /sandboxes/:id/watch?path=&interval=`), SDK (`Sandbox.watch(path, { intervalMs })` async generator), and CLI (`sb watch`). `npm run smoke` opens the stream, creates a file, and asserts the event arrives. Real-time inotify and per-file filters are future refinements.
- [x] `startProcess()` + `waitForPort()`. Background processes are detached with `setsid` and logged to `/tmp/sbx-proc-<id>.log` (streamable via `sb logs`); `waitForPort` probes with bash `/dev/tcp`. Exposed through REST (`/processes`, `/wait-port`), SDK, and CLI (`sb start|ps|kill|logs|wait-port`).
- [x] `exposePort()` + preview-URL proxy. A separate L4 proxy server (`SBX_PROXY_PORT`, default 4751) gives each port a `http://<id>-<port>.localhost:<proxyPort>/` preview URL. **Decision:** the proxy reaches in-container ports through a hijacked `docker exec` of a TCP relay, *not* the container bridge IP — so it works on macOS Docker Desktop where container IPs are unreachable from the host. The relay is `socat` when present (added to `images/base`) and a bash `/dev/tcp` bridge otherwise. It runs **without** a TTY (`Tty:false`) and the daemon demultiplexes Docker's stream frames; an earlier `Tty:true` attempt corrupted bytes because the pty line discipline cooked `\n`→`\r\n` (curl saw "HTTP/0.9"). Connection-level splice means HTTP keep-alive, WebSocket upgrades, and binary/chunked payloads pass through untouched. Path-based fallback route: `/_sbx/<id>/<port>/`. Deferred: TLS/Caddy, wildcard remote domains, mandatory auth (per-port token is optional, loopback-only bind). `npm run smoke` now covers start→wait-port→expose→proxy-fetch→destroy end-to-end.
- [x] Sessions + `setEnvVars()`. Sandbox-level env (`setEnvVars`) is stored on the sandbox record and merged into every `exec`/`startProcess` (precedence: sandbox → session → request). Sessions are a control-plane concept layered on the stateless driver `exec`/`readFile` — no driver change: a session holds a `cwd` + env overlay, and exec within a session appends a `pwd` capture so `cd` persists across commands. Exposed through REST (`/env`, `/sessions`, `sessionId` on exec), SDK (`setEnvVars`/`getEnvVars`/`createSession`/`listSessions` + a `Session` class with `exec`/`setEnvVars`/`destroy`), and CLI (`sb env`, `sb exec`, `sb session create|ls|rm`, plus `--env` on `run`/`start`). `npm run smoke` now covers env application + session cwd/env persistence.
- [x] Persistence (named volume). Each sandbox's `/workspace` is backed by a named Docker volume (`sbx-<id>-workspace`) so files outlive the container. **Decision:** containers are treated as cattle and the volume holds the durable state — `stop` removes the container but keeps the volume, `start` recreates the container and reattaches the volume (data intact), `destroy` removes both. This realizes the `running ↔ stopped` part of the lifecycle FSM and frees compute for idle sandboxes while keeping their files. `persist` is a create-time flag (default true). Exposed through the `Driver` interface (`stop`/`start` + `persist` on `create`), REST (`POST /sandboxes/:id/{stop,start}`), SDK (`Sandbox.stop()`/`start()`/`status`), and CLI (`sb stop <id>`, `sb start <id>` — the latter overloads the process-launch `start` by argument count). On stop, the daemon clears now-dead process/exposed-port state but keeps sessions (just cwd/env). `npm run smoke` now writes a file, stops, starts, and confirms it persisted. **Note:** the daemon's in-memory `SandboxStore` still loses sandbox *records* on daemon restart (SQLite is deferred); the volume persists the *data*, so re-creating a record pointed at the same id would recover the workspace.
- [x] `createBackup`/`restoreBackup` (volume snapshot). **Decision:** instead of CRIU process-checkpointing, a backup is a tarball of `/workspace` taken via Docker's archive API (`getArchive`/`putArchive`) over the Docker socket — no helper container and no container-IP reachability issues, so it works on macOS Docker Desktop. Backups are **durable on the host**: each is a `<backupId>.tar` plus a `<backupId>.json` metadata sidecar under `SBX_BACKUP_DIR` (default `~/.sbx/backups`), and the list endpoint rescans the directory — so backups survive daemon restarts even though the in-memory sandbox store does not. Restore is a **replacement** (workspace cleared before extraction), and a backup taken from one sandbox can be restored into another. Exposed through the `Driver` (`createBackup`/`restoreBackup`), REST (`POST /sandboxes/:id/backups`, `GET /sandboxes/:id/backups`, `POST /sandboxes/:id/restore`, `GET /backups`, `DELETE /backups/:id`), SDK (`Sandbox.createBackup`/`restoreBackup`/`listBackups`, `SbxClient.listBackups`/`deleteBackup`), and CLI (`sb backup`, `sb restore`, `sb backups`). `npm run smoke` covers a backup→mutate→restore→rollback round-trip. CRIU live-process snapshots (for warm-pool resume) remain a Phase 3 item.
- [x] Code interpreter: `createCodeContext()` + `runCode()`. **Stateful** Python and JavaScript: each context runs a long-lived kernel process inside the sandbox that keeps a persistent namespace, so variables/imports survive across `runCode` calls (Jupyter-style). A trailing expression becomes a rich `results` entry (currently `text/plain`); stdout/stderr and tracebacks are captured into `CodeResult`. **Decision:** no Jupyter/IPython dependency and no new `Driver` methods — the kernel (`packages/daemon/src/kernels.ts`: Python via `ast`+`exec`/`eval`, JS via `vm.runInContext`) is provisioned with the existing `exec`/`writeFile`/`startProcess` primitives and serves one cell at a time over a pair of named pipes in its context dir: the daemon writes `cell-<seq>.code`, pushes the seq to `in.fifo`, blocks on `out.fifo` (wrapped in `timeout` so a runaway/wedged cell can't hang the request), then reads the JSON result file. Cells on a context are serialized. One-off `runCode` (no `contextId`) spins up a throwaway kernel and tears it down after. Exposed through REST (`POST`/`GET`/`DELETE /sandboxes/:id/code-contexts`, `POST /sandboxes/:id/run-code`), SDK (`Sandbox.createCodeContext`/`runCode`/`listCodeContexts` + a `CodeContext` class), and CLI (`sb run-code`). `npm run smoke` covers a stateful Python session, stdout/error capture, and a one-off run. **Limitations:** the JS kernel needs `node` (in `images/base`, not the default `python:3.11-slim`); rich non-text outputs (e.g. matplotlib `image/png`), TypeScript, and per-cell streaming are future work — the `results[]`/mime structure already accommodates them.

### Phase 2 — Observability + cost + UI (the differentiator)

Per-sandbox metrics from cgroups; cost meter ($ from CPU-sec/mem-GB-sec/egress with configurable rates); structured logs; OpenTelemetry traces (create→exec→destroy). Web dashboard: sandbox list, live xterm.js terminal, metrics, cost, preview URLs, kill/snapshot. Python SDK.

### Phase 3 — Isolation upgrade + scale-out density

firecracker driver (Linux) + applevz driver (macOS) behind the same interface; vsock agent transport; warm pool + FC snapshot restore; egress credential proxy + default-deny egress + secrets-over-vsock. Per-sandbox isolation mode is selectable (container ↔ microVM).

### Phase 4 — Open-core / managed

Multi-node scheduler (etcd/postgres), teams/auth/SSO/audit, managed cloud offering, supply-chain scanning of agent-installed packages (a noted gap). Apache-2.0 core; commercial features above the line.

---

## Key Technology Choices (grounded in research)

| Concern | Choice | Why |
|---|---|---|
| Daemon + agent + CLI language | Go | Single static binary, easy Linux+macOS cross-compile, native containerd/Firecracker SDKs, great concurrency for density |
| Container runtime (MVP) | containerd/runc (Linux), Apple container / Docker (macOS) | Lightest, highest density, covers both OSes in one driver |
| Strong isolation (phase 3) | Firecracker (Linux), Apple Virtualization (macOS) | <5 MiB/VM, ~125ms boot, 150–1000/host, 5–30ms snapshot resume — density hardware isolation |
| Snapshot/hibernate | FC snapshots / CRIU / btrfs-zfs CoW | Cheap pause→resume; warm pools |
| Preview URLs + TLS | Caddy/certmagic on-demand TLS, wildcard DNS | Zero-config HTTPS per sandbox at scale |
| State | SQLite (embedded) | No external deps single-node; Postgres only for multi-node |
| Metrics/cost | cgroups v2 + OpenTelemetry | Built-in, no per-sandbox sidecar |
| Resource limits | cgroups v2 (systemd scopes) | Hard per-sandbox CPU/mem caps |

**Host note:** Firecracker needs Linux + KVM. GCE supports nested virtualization (and recent EC2 C8i/M8i/R8i now do too), so the $65k GCP credits cover the Linux/Firecracker dev+test host; the spare MacBook covers the Apple-VZ + container path. Get a domain with wildcard DNS early for preview-URL TLS testing.

---

## What you need beyond what you have

- ✅ Spare MacBook → macOS driver dev/test.
- ✅ $65k GCP credits → Linux nested-virt VM (Firecracker), load/density testing.
- ➕ A domain + wildcard DNS (`*.sandbox.<you>`) for preview-URL TLS.
- ➕ (Later) one bare-metal Linux box for honest density benchmarks vs nested-virt overhead.

---

## Verification (end-to-end)

1. **Build:** `go build ./cmd/sbd ./cmd/sb`; cross-compile for `darwin/arm64` + `linux/amd64`.
2. **Mac path:** `sb up` on the spare MacBook → `sb run "python -c 'print(1+1)'"` → confirm streamed output; `sb expose 8000` against a dev server → open preview URL.
3. **Linux/GCE path:** repeat on a nested-virt GCE VM with the container driver; then re-run with `--isolation=firecracker` (phase 3) and confirm identical behavior through the same SDK.
4. **Density test:** script-launch N sandboxes (e.g. 200), each running a trivial agent loop; watch the dashboard's per-sandbox CPU/mem and the cost meter; confirm platform overhead stays a thin slice and the cap is host resources, not our architecture.
5. **Real harness:** run Claude Code / OpenCode / Codex inside a sandbox end-to-end (clone a repo, edit, run tests, expose a preview), with provider keys injected via the egress proxy (phase 3) — confirming the "works with any AI provider" claim.
6. **SDK parity:** run a snippet written against `@cloudflare/sandbox` with only the import swapped to our SDK — confirm drop-in compatibility for `getSandbox`/`exec`/`execStream`/`writeFile`/`exposePort`/`destroy`.
