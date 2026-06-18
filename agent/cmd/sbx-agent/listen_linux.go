//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// defaultVsockPort is the guest port the agent binds when no SBX_AGENT_LISTEN
// override is given. The host driver connects to this port over the guest's
// virtio-vsock device. Overridable via SBX_AGENT_VSOCK_PORT.
const defaultVsockPort = 1024

// listenDefault binds an AF_VSOCK listening socket inside the guest. This is the
// production transport: vsock is a host↔guest-only channel (no network
// exposure), so the agent trusts its single peer (the daemon). Verified by
// cross-compilation here; the live round-trip is exercised on the KVM/VZ host.
func listenDefault() (net.Listener, error) {
	port := defaultVsockPort
	if v := os.Getenv("SBX_AGENT_VSOCK_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			port = p
		}
	}
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock socket: %w", err)
	}
	sa := &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: uint32(port)}
	if err := unix.Bind(fd, sa); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock bind (port %d): %w", port, err)
	}
	if err := unix.Listen(fd, 16); err != nil {
		unix.Close(fd)
		return nil, fmt.Errorf("vsock listen: %w", err)
	}
	return &vsockListener{fd: fd, port: uint32(port)}, nil
}

// vsockListener adapts a raw AF_VSOCK socket to net.Listener so the rest of the
// agent treats it identically to a tcp/unix listener.
type vsockListener struct {
	fd   int
	port uint32
}

func (l *vsockListener) Accept() (net.Conn, error) {
	nfd, _, err := unix.Accept(l.fd)
	if err != nil {
		return nil, err
	}
	// Hand the accepted fd to the net poller. FileConn dups it, so closing the
	// os.File afterwards is correct and leaves the returned conn valid.
	f := os.NewFile(uintptr(nfd), "vsock-conn")
	defer f.Close()
	return net.FileConn(f)
}

func (l *vsockListener) Close() error { return unix.Close(l.fd) }

func (l *vsockListener) Addr() net.Addr { return vsockAddr(l.port) }

type vsockAddr uint32

func (a vsockAddr) Network() string { return "vsock" }
func (a vsockAddr) String() string  { return fmt.Sprintf("vsock://any:%d", uint32(a)) }
