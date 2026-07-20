#!/usr/bin/env bash
# Build the Apple VZ guest artifacts (M1): a rootfs ext4 image with the in-sandbox
# agent as PID 1, plus (TODO) a VZ-compatible kernel.
#
# Rootfs is built with Docker's `mkfs.ext4 -d` (populate-from-directory), which
# needs no loop-mount or privileges — sidestepping macOS's missing mke2fs.
#
# KERNEL — open decision (see docs/plan.md Appendix A.3 / M1 status): Apple VZ
# presents virtio over **PCI**, so the guest kernel needs CONFIG_VIRTIO_PCI=y (plus
# virtio-blk / virtio-console / vsock / ext4), uncompressed arm64 `Image`. The
# Firecracker CI kernels are virtio-MMIO only (no VIRTIO_PCI) and produce zero
# console output under VZ — confirmed. Resolve by either building a minimal kernel
# with VIRTIO_PCI, or switching M1 to VZEFIBootLoader + a stock arm64 distro image.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p guest

# Host-arch aware: the same script builds the arm64 rootfs on a Mac (Apple VZ)
# and the amd64 rootfs on a Linux/KVM box (Firecracker). Override with
# GUEST_ARCH=arm64|amd64 to cross-build.
case "${GUEST_ARCH:-$(uname -m)}" in
  arm64|aarch64) ARCH=arm64 ;;
  amd64|x86_64) ARCH=amd64 ;;
  *) echo "unsupported arch: ${GUEST_ARCH:-$(uname -m)}" >&2; exit 1 ;;
esac

# 1. Agent (built by `npm run build:agent`) → staged into the rootfs as PID-1.
cp "../../agent/dist/hotcell-agent-linux-${ARCH}" guest/hotcell-agent

# 2. Rootfs: alpine userland + agent + the shared guest init (guest/init.sh),
#    booted READ-ONLY (serve.swift mounts it readOnly), so the init backs every
#    writable path with tmpfs or the per-sandbox /dev/vdb disk. The init is the
#    same file convert-image.sh injects into arbitrary OCI images.
docker run --rm --platform "linux/${ARCH}" -v "$PWD/guest:/guest" alpine:3.20 sh -c '
  set -e
  apk add --no-cache e2fsprogs >/dev/null 2>&1
  mkdir -p /rootfs
  cp -a /bin /sbin /usr /etc /lib /rootfs/ 2>/dev/null || true
  # Mountpoints the init needs to exist on the read-only rootfs.
  mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/run /rootfs/tmp /rootfs/var/tmp /rootfs/workspace
  cp /guest/hotcell-agent /rootfs/sbin/hotcell-agent
  cp /guest/init.sh /rootfs/init
  chmod +x /rootfs/init /rootfs/sbin/hotcell-agent
  rm -f /guest/rootfs.img
  mkfs.ext4 -q -F -L sbxroot -d /rootfs /guest/rootfs.img 256M
'
echo "built guest/rootfs.img ($(du -h guest/rootfs.img | cut -f1))"
echo "kernel: TODO — needs a VZ-compatible (virtio-PCI) arm64 kernel; see notes above."
