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

# 1. Agent (built by `npm run build:agent`) → staged into the rootfs as PID-1.
cp ../../agent/dist/sbx-agent-linux-arm64 guest/sbx-agent

# 2. Rootfs: alpine userland + agent + the shared guest init (guest/init.sh),
#    booted READ-ONLY (serve.swift mounts it readOnly), so the init backs every
#    writable path with tmpfs or the per-sandbox /dev/vdb disk. The init is the
#    same file convert-image.sh injects into arbitrary OCI images.
docker run --rm --platform linux/arm64 -v "$PWD/guest:/guest" alpine:3.20 sh -c '
  set -e
  apk add --no-cache e2fsprogs >/dev/null 2>&1
  mkdir -p /rootfs
  cp -a /bin /sbin /usr /etc /lib /rootfs/ 2>/dev/null || true
  # Mountpoints the init needs to exist on the read-only rootfs.
  mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/run /rootfs/tmp /rootfs/workspace
  cp /guest/sbx-agent /rootfs/sbin/sbx-agent
  cp /guest/init.sh /rootfs/init
  chmod +x /rootfs/init /rootfs/sbin/sbx-agent
  rm -f /guest/rootfs.img
  mkfs.ext4 -q -F -L sbxroot -d /rootfs /guest/rootfs.img 256M
'
echo "built guest/rootfs.img ($(du -h guest/rootfs.img | cut -f1))"
echo "kernel: TODO — needs a VZ-compatible (virtio-PCI) arm64 kernel; see notes above."
