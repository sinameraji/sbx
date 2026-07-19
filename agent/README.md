# sbx-agent

The **in-sandbox agent**: a tiny static Linux binary that runs inside each microVM (as PID 1 / init under the Firecracker and Apple VZ drivers) and serves a small framed, multiplexed protocol to the daemon over **vsock**.

This is the per-sandbox piece that replaces `docker exec` once there is no Docker. The container driver gets exec/files/stats "for free" from the Docker Engine API; a microVM has no such thing, so *every* control-plane operation becomes an RPC to this agent. It is **shared verbatim by both microVM drivers** (Firecracker on Linux, Apple VZ on macOS) — the vsock transport is the same on both — so building it once unblocks both.

> Status: protocol + server + transports are built and tested. The vsock transport is cross-compiled and verified to build for `linux/amd64` and `linux/arm64`; its live round-trip is exercised on the KVM/VZ host. Implemented RPCs: `exec` (streaming stdout/stderr/exit), `writeFile`/`readFile`/`mkdir`/`listFiles`, `waitForPort`, `setEnv`, `stats`. Still to add (streaming-heavy): `watch` (inotify), `startProcess`/`listProcesses`/`killProcess`/`streamLogs`, `openPty`+`resize`, `tcpConnect` (preview bridge), `tarWorkspace`/`untarWorkspace`.

## Why Go, why a separate module

- **Go**: trivial static `linux/{amd64,arm64}` cross-compile from macOS with `CGO_ENABLED=0`, and the stdlib (plus `golang.org/x/sys/unix` for `AF_VSOCK`) covers everything the agent needs. The result is a single dependency-free binary (~4 MB) baked into the guest rootfs — the only per-sandbox process we add.
- **Separate module** (`agent/` with its own `go.mod`, like `sdk/python` is top-level): keeps Go out of the npm-workspaces build and the TS toolchain out of the agent.

## Layout

```
agent/
  proto/                 wire protocol — framing + message structs (mirrors the daemon's wire types)
  server/                transport-agnostic Serve(io.ReadWriteCloser) + per-method handlers
    stats_linux.go         real /proc + cgroup reads (the guest)
    stats_other.go         stub so the package compiles/tests on macOS
  cmd/sbx-agent/         entrypoint + transports
    listen_portable.go     tcp:// / unix:// dev transport (any OS)
    listen_linux.go        AF_VSOCK transport (the production path)
    listen_other.go        non-Linux: vsock unavailable, use SBX_AGENT_LISTEN
```

The protocol and server are **pure, portable Go**: `Serve` takes any `io.ReadWriteCloser`, so the whole thing is unit-testable on a developer's macOS box over `net.Pipe` / a unix socket, with no vsock and no guest. Only `stats` is platform-specific.

## Protocol (summary)

A single host↔guest connection multiplexes many streams. Frame:

```
[u32 length][u8 type][u32 streamId][payload]
```

Types: `Control` (JSON request / control msg), `Stdin`/`Stdout`/`Stderr` (byte channels), `EOF`, `Result` (terminal JSON outcome), `Close`. The guest sends an unsolicited `Control` **Hello** on stream 0 at connect; the host's `create()` blocks on it. See `proto/frame.go` for the full spec. Request/Result JSON field names mirror the daemon's `ExecEvent`/`FileInfo`/`SandboxStats`, so the host driver marshals with the same vocabulary it already uses for the container driver.

## Develop / test / build

```bash
cd agent
go test ./...          # protocol + server + transport, all on macOS (no vsock)
go vet ./...

# build for the guest (static, no cgo):
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o hotcell-agent ./cmd/hotcell-agent   # Apple VZ guest
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o hotcell-agent ./cmd/hotcell-agent   # Firecracker on x86
```

From the repo root: `npm run test:agent` / `npm run build:agent`.

### Run it locally (no microVM)

```bash
# terminal 1 — serve over a local socket instead of vsock:
SBX_AGENT_LISTEN=tcp://127.0.0.1:9000 go run ./cmd/sbx-agent
```

A host-side client connects, reads the Hello frame, then sends `Control` request frames and reads back `Stdout`/`Stderr`/`Result` frames. (`server/server_test.go` and `cmd/sbx-agent/listen_portable_test.go` are exactly such clients.)

Inside a guest, with no `SBX_AGENT_LISTEN`, the agent binds `AF_VSOCK` on `SBX_AGENT_VSOCK_PORT` (default 1024) and the daemon connects to it through the VM's virtio-vsock device.
