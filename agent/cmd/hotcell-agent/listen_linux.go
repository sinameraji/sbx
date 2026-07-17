//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

// defaultVsockPort is the guest port the agent binds when no HOTCELL_AGENT_LISTEN
// override is given. The host driver connects to this port over the guest's
// virtio-vsock device. Overridable via HOTCELL_AGENT_VSOCK_PORT.
const defaultVsockPort = 1024

// listenDefault binds an AF_VSOCK listening socket inside the guest. This is the
// production transport: vsock is a host↔guest-only channel (no network
// exposure), so the agent trusts its single peer (the daemon). Verified by
// cross-compilation here; the live round-trip is exercised on the KVM/VZ host.
func listenDefault() (net.Listener, error) {
	port := defaultVsockPort
	if v := agentEnv("AGENT_VSOCK_PORT"); v != "" {
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
	// NOT net.FileConn: it calls getsockname to classify the socket, which Go's
	// net package doesn't implement for AF_VSOCK ("address family not supported"),
	// so it drops the connection. Wrap the raw fd's os.File in a minimal net.Conn
	// instead — the agent protocol only needs Read/Write/Close.
	return &vsockConn{f: os.NewFile(uintptr(nfd), "vsock-conn"), port: l.port}, nil
}

// vsockConn adapts an accepted AF_VSOCK socket fd to net.Conn over its os.File.
type vsockConn struct {
	f    *os.File
	port uint32
}

func (c *vsockConn) Read(b []byte) (int, error)       { return c.f.Read(b) }
func (c *vsockConn) Write(b []byte) (int, error)      { return c.f.Write(b) }
func (c *vsockConn) Close() error                     { return c.f.Close() }
func (c *vsockConn) LocalAddr() net.Addr              { return vsockAddr(c.port) }
func (c *vsockConn) RemoteAddr() net.Addr             { return vsockAddr(c.port) }
func (c *vsockConn) SetDeadline(t time.Time) error    { return c.f.SetDeadline(t) }
func (c *vsockConn) SetReadDeadline(t time.Time) error  { return c.f.SetReadDeadline(t) }
func (c *vsockConn) SetWriteDeadline(t time.Time) error { return c.f.SetWriteDeadline(t) }

func (l *vsockListener) Close() error { return unix.Close(l.fd) }

func (l *vsockListener) Addr() net.Addr { return vsockAddr(l.port) }

type vsockAddr uint32

func (a vsockAddr) Network() string { return "vsock" }
func (a vsockAddr) String() string  { return fmt.Sprintf("vsock://any:%d", uint32(a)) }
