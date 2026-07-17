//go:build linux

package main

import (
	"fmt"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// egressDial opens a guest→host vsock connection (CID 2 = the host) for the
// egress relay — the production path inside a microVM. HOTCELL_EGRESS_DIAL
// overrides it for VM-free tests.
func egressDial(port uint32) (net.Conn, error) {
	if override := egressDialOverride(); override != nil {
		return override(port)
	}
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	sa := &unix.SockaddrVM{CID: unix.VMADDR_CID_HOST, Port: port}
	if err := unix.Connect(fd, sa); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock connect (host:%d): %w", port, err)
	}
	return &vsockConn{f: os.NewFile(uintptr(fd), "vsock-egress"), port: port}, nil
}
