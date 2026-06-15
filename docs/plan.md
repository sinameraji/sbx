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
- [ ] Acceptance: on both a Mac and a GCE Linux VM — create a sandbox, run a command, watch output stream live, destroy it. Run an actual harness (Claude Code or OpenCode) inside one sandbox. **Partially done:** `npm run smoke` exercises create → exec → destroy locally. Multi-OS/harness validation is still pending.

### Phase 1 — Core sandbox API

Files (`writeFile`/`readFile`/`mkdir`/`listFiles`/`watch`), `startProcess()` + `waitForPort()`, `exposePort()` + preview-URL proxy, sessions + `setEnvVars()`, persistence (named volume), `createBackup`/`restoreBackup` (volume or CRIU snapshot). Code interpreter: `createCodeContext()` + `runCode()` (Python/JS/TS, rich outputs).

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
