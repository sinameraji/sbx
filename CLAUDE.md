# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**sbx** is self-hostable sandbox infrastructure for AI agents — spin up many isolated, observable sandboxes on your own hardware instead of a managed cloud. It's an npm-workspaces monorepo of TypeScript ES modules (Node ≥20). Currently a **Phase 0/1 vertical slice**: a Docker-backed container driver only; Firecracker/Apple VZ microVM drivers are planned but not built.

Two long-form docs already exist and are the source of truth — read them before large changes:
- `docs/plan.md` — product spec, full target architecture, and phased roadmap (Phase 0→4).
- `KIMI.md` — detailed AI-agent context (conventions, troubleshooting, dependency policy).

## Commands

All from the repo root unless noted. There are **no test/lint/format scripts** — type-checking via `tsc` (during `build`) is the only static check.

```bash
npm install                          # first step
npm run build                        # tsc all workspaces -> packages/*/dist
npm run dev:daemon                   # daemon in watch mode (tsx, no dist write)
npm run dev:cli                      # CLI in watch mode (tsx)
npm run smoke                        # build + run packages/daemon/dist/smoke.js (create→exec→files→destroy)
node packages/daemon/dist/index.js   # start compiled daemon (listens on 127.0.0.1:4750)
```

The daemon (`sbd`) requires a running Docker-compatible runtime (Docker Desktop / colima / Apple `container`). `npm run smoke` is the closest thing to an end-to-end test.

Daemon config via env (`packages/daemon/src/config.ts`): `SBX_HOST` (127.0.0.1), `SBX_PORT` (4750), `SBX_IMAGE` (`python:3.11-slim-bookworm`). SDK/CLI endpoint via `SBX_ENDPOINT`.

## Architecture

Three workspaces plus a base image, layered client → daemon → driver → Docker:

- **`packages/daemon`** (`@sbx/daemon`, bin `sbd`) — control plane. Hand-rolled `node:http` REST server (`src/api/server.ts`), `SandboxStore` (`src/store.ts`, embedded SQLite via `node:sqlite` with a write-through in-memory cache — survives daemon restart), and the runtime-driver layer.
- **`packages/sdk`** (`@sbx/sdk`) — zero-runtime-dependency TS client mirroring the Cloudflare Sandbox SDK surface (`SbxClient.getSandbox`, `Sandbox.exec`/`execStream`/`writeFile`/`readFile`/`mkdir`/`listFiles`/`destroy`). Keep it dependency-free.
- **`packages/cli`** (`@sbx/cli`, bin `sb`) — `sb run | ls | rm | files`, built on `@sbx/sdk`.
- **`images/base`** — richer OCI image (Python 3.11 + Node 20 + git/bash); build it and set `SBX_IMAGE=sbx/base:latest` to use it.

**The central abstraction is the `Driver` interface** (`packages/daemon/src/driver/types.ts`): `create / exec / writeFile / readFile / mkdir / listFiles / destroy / ping`. The only implementation today is `ContainerDriver` (`src/driver/container.ts`), which keeps a long-lived Docker container alive (`sleep infinity`) and `exec`s into it on demand. Future microVM drivers implement this same surface so the daemon, SDK, and CLI stay unchanged. **When adding a sandbox capability, add it to the `Driver` interface first, then the container impl, then expose it through REST → SDK → CLI** (that layering is the existing pattern; see how file ops were added across all four).

**Request flow:** SDK method → daemon REST endpoint → `store.get(id)` → `driver.<op>`. `exec` output streams back as Server-Sent Events (`data: <json ExecEvent>\n\n`); the SDK's `parseSSE` turns frames back into typed `ExecEvent`s (`stdout`/`stderr`/`exit`). When changing the exec wire format, keep the SSE writer in `server.ts` and `parseSSE` in `sdk/src/index.ts` in sync.

## Conventions that bite if ignored

- **ES modules + `NodeNext` resolution:** relative imports MUST carry the `.js` extension (`import { loadConfig } from "./config.js"`), even though the source is `.ts`. Prefix Node built-ins with `node:`.
- Named exports only; no CommonJS. Every package is `"type": "module"`.
- Each workspace extends `tsconfig.base.json` (strict, ES2022, `outDir: dist`, `rootDir: src`). The SDK additionally includes the `DOM` lib because it consumes `fetch`'s `ReadableStream`.
- Don't add a heavy web framework to the daemon — the hand-rolled server is intentional for Phase 0.
- Commit `package-lock.json` changes. Conventional commit prefixes (`feat:`, `daemon:`, `docs:`) are used; work happens on `main`.
- Update `docs/plan.md` when architectural decisions change.
