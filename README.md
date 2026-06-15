# sbx

**Self-hostable sandbox infrastructure for AI agents.** Spin up many secure, persistent, observable sandboxes for coding agents (Claude Code, Codex, OpenCode, …) on *your own* hardware — a Mac, an EC2/GCE VM, or bare-metal Linux. No vendor lock-in. CLI-first, with a web dashboard.

> Status: **MVP — Phases 0 & 1 complete, Phase 2 (observability) in progress.** Container driver (Docker) works on Linux + macOS, with durable state, idle auto-pause/resume, per-sandbox metrics + cost meter, and a web dashboard. Firecracker / Apple Virtualization microVM drivers are planned.

## Why

`sbx` brings together what agent workloads need on your own infrastructure: **self-hosted + permissive (Apache-2.0) + isolation-optional + built-in observability & cost visibility + dev-first UX.** Run it on hardware you control, with predictable cost and no vendor lock-in.

Design constraint #1: you should be able to launch *as many* agents/sandboxes as your *hardware* allows — the architecture adds near-zero per-sandbox overhead.

## Architecture (target)

- **`sbd`** — single control-plane daemon per host: REST/WS API, scheduler + warm pool, preview-URL proxy, metrics + cost meter, pluggable runtime drivers.
- **Runtime drivers** — `container` (containerd/Docker on Linux, Apple `container` on macOS) for max density today; `firecracker` (Linux) and `applevz` (macOS) microVM drivers for hardware isolation next.
- **In-sandbox agent** — tiny static binary (the only per-sandbox overhead); Docker exec for the container driver in Phase 0.
- **SDKs** — TypeScript + Python, mirroring the Cloudflare Sandbox surface (`getSandbox`, `exec`, `execStream`, …) so existing harnesses adopt with near-zero friction.
- **`sb`** — CLI. **Web dashboard** — live terminal, per-sandbox metrics, cost meter, preview URLs.

## Packages

| Package | What |
|---|---|
| `packages/daemon` (`@sbx/daemon`, bin `sbd`) | The control-plane daemon |
| `packages/sdk` (`@sbx/sdk`) | TypeScript client SDK |
| `packages/cli` (`@sbx/cli`, bin `sb`) | Command-line interface |
| `sdk/python` (`sbx-sdk`) | Python client SDK (stdlib-only, mirrors the TS SDK) |
| `images/base` | Base sandbox OCI image (Python 3.11 + Node 20 + git/bash) |

## Quick start (Phase 0)

Requires Docker running locally.

```bash
npm install
npm run build

# start the daemon
node packages/daemon/dist/index.js          # or: sb up

# in another shell — run a command in a fresh sandbox
sb run "python3 -c 'print(2+2)'"

# resource usage + cost for a sandbox
sb stats <id>
```

Then open the **web dashboard** at <http://127.0.0.1:4750/> — sandbox list, live CPU/mem/net, cost meter, preview links, and stop/start/destroy.

From Python (`sdk/python`, stdlib-only):

```python
from sbx import SbxClient

sandbox = SbxClient().get_sandbox()
print(sandbox.exec("python3 -c 'print(2+2)'").stdout)   # "4\n"
sandbox.destroy()
```

## License

Apache-2.0
