package main

import (
	"fmt"
	"net"
	"os"
	"strings"
)

// dialSpec parses a scheme://addr dial spec (the SBX_EGRESS_DIAL test
// override). Supported: tcp://host:port and unix:///path/to.sock — mirrors
// listenSpec so the egress relay is exercisable on any OS without a microVM.
func dialSpec(spec string) (net.Conn, error) {
	scheme, addr, ok := strings.Cut(spec, "://")
	if !ok {
		return nil, fmt.Errorf("SBX_EGRESS_DIAL must be scheme://addr, got %q", spec)
	}
	switch scheme {
	case "tcp":
		return net.Dial("tcp", addr)
	case "unix":
		return net.Dial("unix", addr)
	default:
		return nil, fmt.Errorf("unsupported SBX_EGRESS_DIAL scheme %q (use tcp:// or unix://)", scheme)
	}
}

// egressDialOverride returns the test-override dialer when SBX_EGRESS_DIAL is
// set, else nil (the platform dialer takes over).
func egressDialOverride() func(port uint32) (net.Conn, error) {
	spec := os.Getenv("SBX_EGRESS_DIAL")
	if spec == "" {
		return nil
	}
	return func(uint32) (net.Conn, error) { return dialSpec(spec) }
}
