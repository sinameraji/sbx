// Command sbx-agent is the in-sandbox agent: a tiny static Linux binary that
// runs inside each microVM (as PID 1 / init under the Firecracker and Apple VZ
// drivers) and serves the proto protocol to the daemon over vsock. It is the
// per-sandbox piece that replaces `docker exec` once there is no Docker — and
// is shared verbatim by both microVM drivers.
//
// Transport selection:
//   - SBX_AGENT_LISTEN set (e.g. "tcp://127.0.0.1:9000" or "unix:///tmp/a.sock")
//     → listen there. This is the dev/test path and works on any OS, so the
//     agent can be exercised on a developer's macOS box without a guest.
//   - otherwise → vsock (Linux only; the production path inside a guest).
package main

import (
	"log"
	"net"
	"os"

	"github.com/sinameraji/sbx/agent/server"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix("sbx-agent ")

	ag := server.New()
	ln, err := listen()
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("listening on %s (version %s)", ln.Addr(), server.Version)

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			return
		}
		go func(c net.Conn) {
			if err := ag.Serve(c); err != nil {
				log.Printf("serve: %v", err)
			}
		}(conn)
	}
}

// listen picks the transport: the explicit SBX_AGENT_LISTEN spec if present,
// else the platform default (vsock on Linux; an error elsewhere).
func listen() (net.Listener, error) {
	if spec := os.Getenv("SBX_AGENT_LISTEN"); spec != "" {
		return listenSpec(spec)
	}
	return listenDefault()
}
