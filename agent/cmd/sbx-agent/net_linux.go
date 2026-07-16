//go:build linux

package main

import "golang.org/x/sys/unix"

// platformInit brings up the loopback interface. The guest init tries
// `ip`/`ifconfig`, but slim OCI images (debian-slim, distroless) ship neither —
// and the agent needs 127.0.0.1 for its egress relay listener. A raw ioctl
// works in every image because the agent is static.
func platformInit() {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return
	}
	defer unix.Close(fd)
	ifr, err := unix.NewIfreq("lo")
	if err != nil {
		return
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
		return
	}
	flags := ifr.Uint16()
	if flags&unix.IFF_UP == 0 {
		ifr.SetUint16(flags | unix.IFF_UP)
		_ = unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
	}
}
