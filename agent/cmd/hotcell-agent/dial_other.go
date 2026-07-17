//go:build !linux

package main

import (
	"fmt"
	"net"
)

// egressDial on non-Linux dev hosts: only the SBX_EGRESS_DIAL test override —
// there is no vsock outside a Linux guest.
func egressDial(port uint32) (net.Conn, error) {
	if override := egressDialOverride(); override != nil {
		return override(port)
	}
	return nil, fmt.Errorf("egress dial: vsock is Linux-only (set SBX_EGRESS_DIAL for tests)")
}
