package server

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sinameraji/sbx/agent/proto"
)

// testClient is a minimal host-side driver: it speaks proto over a pipe to a
// served Agent, exactly as the future FirecrackerDriver/AppleVzDriver will over
// vsock. It collects frames per streamId.
type testClient struct {
	t   *testing.T
	w   *proto.FrameWriter
	r   io.Reader
	seq uint32
}

func newTestClient(t *testing.T) (*testClient, *Agent, func()) {
	c1, c2 := net.Pipe()
	a := New()
	go a.Serve(c2)
	tc := &testClient{t: t, w: proto.NewFrameWriter(c1), r: c1}
	// First frame must be the Hello greeting on stream 0.
	f := tc.read()
	if f.Type != proto.Control || f.StreamID != 0 {
		t.Fatalf("expected hello control on stream 0, got %v/%d", f.Type, f.StreamID)
	}
	var hello proto.Hello
	if err := json.Unmarshal(f.Payload, &hello); err != nil || hello.Event != "hello" {
		t.Fatalf("bad hello: %q (%v)", f.Payload, err)
	}
	return tc, a, func() { c1.Close() }
}

func (tc *testClient) read() proto.Frame {
	tc.t.Helper()
	f, err := proto.ReadFrame(tc.r)
	if err != nil {
		tc.t.Fatalf("read frame: %v", err)
	}
	return f
}

func (tc *testClient) call(req proto.Request) uint32 {
	tc.t.Helper()
	tc.seq++
	id := tc.seq
	b, _ := json.Marshal(req)
	if err := tc.w.Write(proto.Control, id, b); err != nil {
		tc.t.Fatalf("write control: %v", err)
	}
	return id
}

// collect reads frames for stream id until its Result, returning stdout, stderr
// and the parsed Result.
func (tc *testClient) collect(id uint32) (stdout, stderr []byte, res proto.Result) {
	tc.t.Helper()
	for {
		f := tc.read()
		if f.StreamID != id {
			continue
		}
		switch f.Type {
		case proto.Stdout:
			stdout = append(stdout, f.Payload...)
		case proto.Stderr:
			stderr = append(stderr, f.Payload...)
		case proto.ResultFrame:
			if err := json.Unmarshal(f.Payload, &res); err != nil {
				tc.t.Fatalf("bad result json: %v", err)
			}
			return stdout, stderr, res
		}
	}
}

func TestExecStdoutStderrExit(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()

	id := tc.call(proto.Request{Method: "exec", Command: "echo out; echo err 1>&2; exit 3", Cwd: "/tmp"})
	stdout, stderr, res := tc.collect(id)

	if string(stdout) != "out\n" {
		t.Fatalf("stdout = %q, want %q", stdout, "out\n")
	}
	if string(stderr) != "err\n" {
		t.Fatalf("stderr = %q, want %q", stderr, "err\n")
	}
	if !res.OK || res.ExitCode == nil || *res.ExitCode != 3 {
		t.Fatalf("result = %+v, want ok with exit 3", res)
	}
}

func TestExecInheritsSetEnv(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()

	// setEnv establishes a sandbox-level var; a later exec must see it.
	if _, _, res := tc.collect(tc.call(proto.Request{
		Method: "setEnv", Env: map[string]string{"SBX_TEST_VAR": "sandbox"},
	})); !res.OK {
		t.Fatalf("setEnv failed: %+v", res)
	}
	// Per-request env overrides the sandbox env.
	stdout, _, res := tc.collect(tc.call(proto.Request{
		Method:  "exec",
		Command: "printf '%s' \"$SBX_TEST_VAR-$REQ_VAR\"",
		Cwd:     "/tmp",
		Env:     map[string]string{"REQ_VAR": "req"},
	}))
	if !res.OK {
		t.Fatalf("exec failed: %+v", res)
	}
	if string(stdout) != "sandbox-req" {
		t.Fatalf("env merge = %q, want %q", stdout, "sandbox-req")
	}
}

func TestFileRoundTrip(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()
	dir := t.TempDir()

	sub := filepath.Join(dir, "a", "b")
	if _, _, res := tc.collect(tc.call(proto.Request{Method: "mkdir", Path: sub, Parents: true})); !res.OK {
		t.Fatalf("mkdir: %+v", res)
	}
	file := filepath.Join(sub, "hello.txt")
	if _, _, res := tc.collect(tc.call(proto.Request{Method: "writeFile", Path: file, Content: "hello agent"})); !res.OK {
		t.Fatalf("writeFile: %+v", res)
	}
	_, _, res := tc.collect(tc.call(proto.Request{Method: "readFile", Path: file}))
	if !res.OK || res.Value.(string) != "hello agent" {
		t.Fatalf("readFile = %+v, want 'hello agent'", res)
	}

	// listFiles on the subdir should show exactly hello.txt.
	_, _, res = tc.collect(tc.call(proto.Request{Method: "listFiles", Path: sub}))
	if !res.OK {
		t.Fatalf("listFiles: %+v", res)
	}
	entries := res.Value.([]any)
	if len(entries) != 1 {
		t.Fatalf("listFiles returned %d entries, want 1", len(entries))
	}
	fi := entries[0].(map[string]any)
	if fi["name"] != "hello.txt" || fi["isDirectory"] != false {
		t.Fatalf("listFiles entry = %+v", fi)
	}
}

func TestWaitForPort(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()

	// Listen on an ephemeral port, then assert waitForPort sees it.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	_, _, res := tc.collect(tc.call(proto.Request{
		Method: "waitForPort", Port: port, Host: "127.0.0.1", TimeoutMs: 2000, IntervalMs: 50,
	}))
	if !res.OK || res.Value.(bool) != true {
		t.Fatalf("waitForPort(open) = %+v, want true", res)
	}

	// A closed port should time out to false quickly.
	_, _, res = tc.collect(tc.call(proto.Request{
		Method: "waitForPort", Port: closedPort(t), Host: "127.0.0.1", TimeoutMs: 200, IntervalMs: 50,
	}))
	if !res.OK || res.Value.(bool) != false {
		t.Fatalf("waitForPort(closed) = %+v, want false", res)
	}
}

func TestStats(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()
	_, _, res := tc.collect(tc.call(proto.Request{Method: "stats"}))
	if !res.OK {
		t.Fatalf("stats: %+v", res)
	}
	m := res.Value.(map[string]any)
	if _, ok := m["sampledAt"]; !ok {
		t.Fatalf("stats missing sampledAt: %+v", m)
	}
	if m["onlineCpus"].(float64) < 1 {
		t.Fatalf("stats onlineCpus = %v, want >= 1", m["onlineCpus"])
	}
}

func TestUnknownMethod(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()
	_, _, res := tc.collect(tc.call(proto.Request{Method: "teleport"}))
	if res.OK || res.Error == "" {
		t.Fatalf("unknown method should error, got %+v", res)
	}
}

func closedPort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close() // free it so nothing is listening
	return port
}

// Guard against a wedged test hanging CI forever.
func TestMain(m *testing.M) {
	done := make(chan int, 1)
	go func() { done <- m.Run() }()
	select {
	case code := <-done:
		os.Exit(code)
	case <-time.After(60 * time.Second):
		os.Stderr.WriteString("server tests timed out\n")
		os.Exit(1)
	}
}
