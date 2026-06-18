//go:build !linux

package main

import (
	"errors"
	"net"
)

// listenDefault has no vsock transport off Linux. The agent only ever runs as a
// Linux guest in production; on a developer's macOS box, drive it over a local
// socket via SBX_AGENT_LISTEN instead.
func listenDefault() (net.Listener, error) {
	return nil, errors.New("vsock transport is only available on the Linux guest; set SBX_AGENT_LISTEN=tcp://… or unix://… for local dev")
}
