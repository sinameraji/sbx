// Package server implements the in-sandbox sbx-agent: it serves the proto
// protocol over a single connection (vsock in production, a unix/tcp socket in
// dev/tests) and turns each request into a local OS action — exactly the work
// `docker exec` does for the container driver, but from inside a microVM where
// there is no docker.
//
// The server is transport-agnostic: Serve takes any io.ReadWriteCloser, so the
// protocol and every handler are unit-testable on any OS over net.Pipe, with no
// vsock and no guest. Only stats is platform-specific (real /proc reads on
// Linux; a stub elsewhere), kept behind build tags.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/sinameraji/sbx/agent/proto"
)

// Version is the agent build version, surfaced in the Hello greeting.
const Version = "0.1.0"

// Agent serves the protocol for one sandbox guest. A single Agent instance is
// reused across connections; its env overlay (seeded from the process
// environment, mutated by setEnv) is the sandbox-level env every exec inherits,
// mirroring how the container driver bakes sandbox env into the container.
type Agent struct {
	mu  sync.RWMutex
	env map[string]string
}

// New returns an Agent seeded with the current process environment as its
// sandbox-level env base.
func New() *Agent {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if i := indexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	return &Agent{env: env}
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// stream is an in-flight request that accepts further input frames (exec/pty
// stdin, untar bytes). Request/response methods (files, stats) need none.
type stream struct {
	cancel context.CancelFunc
	stdin  io.WriteCloser // process stdin; nil if the handler takes no input
}

// Serve runs the protocol loop on conn until it closes or errors. It sends the
// Hello greeting first, then dispatches each Control frame to a handler
// goroutine and routes Stdin/EOF/Close frames to the addressed stream.
func (a *Agent) Serve(conn io.ReadWriteCloser) error {
	defer conn.Close()
	w := proto.NewFrameWriter(conn)

	hello, _ := json.Marshal(proto.Hello{
		Event:   "hello",
		Agent:   "sbx-agent",
		Version: Version,
		Proto:   proto.ProtoVersion,
	})
	if err := w.Write(proto.Control, 0, hello); err != nil {
		return err
	}

	var mu sync.Mutex
	streams := map[uint32]*stream{}
	var wg sync.WaitGroup
	defer wg.Wait()

	br := bufio.NewReader(conn)
	for {
		f, err := proto.ReadFrame(br)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		switch f.Type {
		case proto.Control:
			var req proto.Request
			if err := json.Unmarshal(f.Payload, &req); err != nil {
				writeError(w, f.StreamID, "bad request json: "+err.Error())
				continue
			}
			ctx, cancel := context.WithCancel(context.Background())
			st := &stream{cancel: cancel}
			mu.Lock()
			streams[f.StreamID] = st
			mu.Unlock()
			wg.Add(1)
			go func(id uint32, req proto.Request) {
				defer wg.Done()
				defer func() {
					mu.Lock()
					delete(streams, id)
					mu.Unlock()
					cancel()
				}()
				a.dispatch(ctx, w, id, req, st, &mu)
			}(f.StreamID, req)
		case proto.Stdin:
			mu.Lock()
			st := streams[f.StreamID]
			mu.Unlock()
			if st != nil && st.stdin != nil {
				st.stdin.Write(f.Payload)
			}
		case proto.EOF:
			mu.Lock()
			st := streams[f.StreamID]
			mu.Unlock()
			if st != nil && st.stdin != nil {
				st.stdin.Close()
			}
		case proto.Close:
			mu.Lock()
			st := streams[f.StreamID]
			mu.Unlock()
			if st != nil {
				st.cancel()
			}
		}
	}
}

// dispatch routes one request to its handler. Handlers stream output as
// Stdout/Stderr frames and end with a Result frame on the same streamId.
func (a *Agent) dispatch(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	switch req.Method {
	case "exec":
		a.handleExec(ctx, w, id, req, st, mu)
	case "writeFile":
		a.handleWriteFile(w, id, req)
	case "readFile":
		a.handleReadFile(w, id, req)
	case "mkdir":
		a.handleMkdir(w, id, req)
	case "listFiles":
		a.handleListFiles(w, id, req)
	case "waitForPort":
		a.handleWaitForPort(ctx, w, id, req)
	case "tcpConnect":
		a.handleTcpConnect(ctx, w, id, req, st, mu)
	case "setEnv":
		a.handleSetEnv(w, id, req)
	case "stats":
		a.handleStats(w, id)
	default:
		writeError(w, id, "unknown method: "+req.Method)
	}
}

// mergedEnv returns the process environment overlaid with the sandbox env and
// then the per-request env (request wins), as a KEY=VALUE slice for exec.
func (a *Agent) mergedEnv(reqEnv map[string]string) []string {
	a.mu.RLock()
	merged := make(map[string]string, len(a.env)+len(reqEnv))
	for k, v := range a.env {
		merged[k] = v
	}
	a.mu.RUnlock()
	for k, v := range reqEnv {
		merged[k] = v
	}
	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	return out
}

// shellInvocation picks the closest match to the container driver's
// `/bin/bash -lc <command>`, falling back to `/bin/sh -c` when bash is absent
// (slim guest rootfs).
func shellInvocation(command string) (string, []string) {
	if path, err := exec.LookPath("bash"); err == nil {
		return path, []string{"-lc", command}
	}
	return "/bin/sh", []string{"-c", command}
}

func (a *Agent) handleExec(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	shell, args := shellInvocation(req.Command)
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Dir = req.Cwd
	if cmd.Dir == "" {
		cmd.Dir = "/workspace"
	}
	cmd.Env = a.mergedEnv(req.Env)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		writeError(w, id, "stdin pipe: "+err.Error())
		return
	}
	mu.Lock()
	st.stdin = stdin
	mu.Unlock()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, id, "stdout pipe: "+err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		writeError(w, id, "stderr pipe: "+err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		writeError(w, id, "start: "+err.Error())
		return
	}

	var pump sync.WaitGroup
	pump.Add(2)
	go func() { defer pump.Done(); copyToFrames(w, proto.Stdout, id, stdout) }()
	go func() { defer pump.Done(); copyToFrames(w, proto.Stderr, id, stderr) }()
	pump.Wait()

	exitCode := 0
	if err := cmd.Wait(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}
	writeResult(w, id, proto.Result{OK: true, ExitCode: &exitCode})
}

// copyToFrames streams r as a sequence of typed frames on streamId until EOF.
func copyToFrames(w *proto.FrameWriter, t proto.FrameType, id uint32, r io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if werr := w.Write(t, id, buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (a *Agent) handleWriteFile(w *proto.FrameWriter, id uint32, req proto.Request) {
	mode := parseMode(req.Mode, 0o644)
	if err := os.WriteFile(req.Path, []byte(req.Content), mode); err != nil {
		writeError(w, id, err.Error())
		return
	}
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleReadFile(w *proto.FrameWriter, id uint32, req proto.Request) {
	data, err := os.ReadFile(req.Path)
	if err != nil {
		writeError(w, id, err.Error())
		return
	}
	writeResult(w, id, proto.Result{OK: true, Value: string(data)})
}

func (a *Agent) handleMkdir(w *proto.FrameWriter, id uint32, req proto.Request) {
	var err error
	if req.Parents {
		err = os.MkdirAll(req.Path, 0o755)
	} else {
		err = os.Mkdir(req.Path, 0o755)
	}
	if err != nil {
		writeError(w, id, err.Error())
		return
	}
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleListFiles(w *proto.FrameWriter, id uint32, req proto.Request) {
	entries, err := os.ReadDir(req.Path)
	if err != nil {
		writeError(w, id, err.Error())
		return
	}
	out := make([]proto.FileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue // entry vanished between ReadDir and Info; skip
		}
		out = append(out, proto.FileInfo{
			Path:        filepath.Join(req.Path, e.Name()),
			Name:        e.Name(),
			IsDirectory: e.IsDir(),
			Size:        info.Size(),
			ModifiedAt:  info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	writeResult(w, id, proto.Result{OK: true, Value: out})
}

func (a *Agent) handleWaitForPort(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request) {
	host := req.Host
	if host == "" {
		host = "127.0.0.1"
	}
	timeout := durOrDefault(req.TimeoutMs, 30*time.Second)
	interval := durOrDefault(req.IntervalMs, 250*time.Millisecond)
	deadline := time.Now().Add(timeout)
	addr := net.JoinHostPort(host, strconv.Itoa(req.Port))
	for {
		if ctx.Err() != nil {
			writeResult(w, id, proto.Result{OK: true, Value: false})
			return
		}
		conn, err := net.DialTimeout("tcp", addr, interval)
		if err == nil {
			conn.Close()
			writeResult(w, id, proto.Result{OK: true, Value: true})
			return
		}
		if time.Now().After(deadline) {
			writeResult(w, id, proto.Result{OK: true, Value: false})
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(interval):
		}
	}
}

// handleTcpConnect dials host:port inside the guest and bridges it to the stream:
// Stdin frames are written to the connection (host→service), the connection's
// output is streamed back as Stdout frames (service→host). Backs the preview-URL
// proxy. The stream's stdin is the dialed conn; a Close/cancel from the host shuts
// the connection so the read loop unblocks.
func (a *Agent) handleTcpConnect(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	host := req.Host
	if host == "" {
		host = "127.0.0.1"
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(req.Port)), 10*time.Second)
	if err != nil {
		writeError(w, id, "tcpConnect: "+err.Error())
		return
	}
	defer conn.Close()
	mu.Lock()
	st.stdin = conn // host Stdin frames → the dialed connection
	mu.Unlock()
	go func() {
		<-ctx.Done()
		conn.Close() // unblock the read loop when the host closes the stream
	}()
	copyToFrames(w, proto.Stdout, id, conn) // connection output → Stdout frames
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleSetEnv(w *proto.FrameWriter, id uint32, req proto.Request) {
	a.mu.Lock()
	for k, v := range req.Env {
		a.env[k] = v
	}
	a.mu.Unlock()
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleStats(w *proto.FrameWriter, id uint32) {
	s := readStats() // platform-specific (stats_linux.go / stats_other.go)
	s.SampledAt = time.Now().UTC().Format(time.RFC3339)
	writeResult(w, id, proto.Result{OK: true, Value: s})
}

func writeResult(w *proto.FrameWriter, id uint32, r proto.Result) {
	b, _ := json.Marshal(r)
	w.Write(proto.ResultFrame, id, b)
}

func writeError(w *proto.FrameWriter, id uint32, msg string) {
	writeResult(w, id, proto.Result{OK: false, Error: msg})
}

func parseMode(s string, def os.FileMode) os.FileMode {
	if s == "" {
		return def
	}
	if v, err := strconv.ParseUint(s, 8, 32); err == nil {
		return os.FileMode(v)
	}
	return def
}

func durOrDefault(ms int, def time.Duration) time.Duration {
	if ms <= 0 {
		return def
	}
	return time.Duration(ms) * time.Millisecond
}
