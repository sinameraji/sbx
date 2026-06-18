package main

import (
	"fmt"
	"net"
	"os"
	"strings"
)

// listenSpec parses a scheme://addr listen spec for the dev/test transport.
// Supported: tcp://host:port and unix:///path/to.sock. Available on all OSes so
// the agent can be driven locally without a microVM.
func listenSpec(spec string) (net.Listener, error) {
	scheme, addr, ok := strings.Cut(spec, "://")
	if !ok {
		return nil, fmt.Errorf("SBX_AGENT_LISTEN must be scheme://addr, got %q", spec)
	}
	switch scheme {
	case "tcp":
		return net.Listen("tcp", addr)
	case "unix":
		os.Remove(addr) // clear a stale socket from a prior run
		return net.Listen("unix", addr)
	default:
		return nil, fmt.Errorf("unsupported SBX_AGENT_LISTEN scheme %q (use tcp:// or unix://)", scheme)
	}
}
