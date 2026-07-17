//go:build !linux

package main

// platformInit is a no-op on dev hosts (loopback is already up).
func platformInit() {}
