#!/usr/bin/env bash
# Build a minimal VZ-compatible arm64 kernel: stock arm64 defconfig (which boots
# under VZ) + virtio over PCI and vsock built in (=y, no initramfs needed).
# Output: helpers/sbx-vz/guest/vmlinux-vz (uncompressed arm64 Image). Reused by
# the Firecracker driver later. ~15-30 min compile in an arm64 Docker container.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p guest
docker run --rm --platform linux/arm64 -v "$PWD/guest:/out" debian:bookworm bash -c '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  # Robust apt: retry transient mirror timeouts.
  for attempt in 1 2 3 4 5; do
    apt-get update -qq && \
    apt-get -o Acquire::Retries=5 install -y -qq \
      bc bison flex libssl-dev make gcc libelf-dev curl xz-utils ca-certificates && break
    echo "apt attempt $attempt failed; retrying..."; sleep 5
  done
  command -v gcc >/dev/null || { echo "FATAL: toolchain install failed"; exit 1; }
  cd /tmp
  V=6.6.52
  curl -fsSL --retry 5 -o linux.tar.xz https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$V.tar.xz
  tar xJf linux.tar.xz
  cd linux-$V
  make defconfig >/dev/null
  ./scripts/config --enable VIRTIO --enable VIRTIO_PCI --enable VIRTIO_BLK \
    --enable VIRTIO_CONSOLE --enable VIRTIO_NET --enable VSOCKETS \
    --enable VIRTIO_VSOCKETS --enable EXT4_FS --enable DEVTMPFS --enable DEVTMPFS_MOUNT
  make olddefconfig >/dev/null
  echo "building Image with $(nproc) jobs..."
  make -j"$(nproc)" Image >/dev/null 2>&1
  cp arch/arm64/boot/Image /out/vmlinux-vz
  echo "KERNEL_BUILT $(stat -c%s /out/vmlinux-vz) bytes"
'
