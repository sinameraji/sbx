#!/usr/bin/env bash
# Convert an OCI image into a VZ-bootable read-only ext4 rootfs: export the
# image's filesystem, inject the in-sandbox agent (PID 1 via /init) + the shared
# guest init, and mkfs.ext4 it. Honors SBX_IMAGE so a VZ sandbox runs the same
# image as the container driver (e.g. python:3.11-slim).
#
# No privileges / loop-mounts needed (macOS has no mke2fs): the build runs in an
# alpine container with e2fsprogs, using `mkfs.ext4 -d` to populate from a dir —
# the same trick build-guest.sh uses for the Alpine base.
#
# Usage: convert-image.sh <image> <out.img> <agent> <init> [platform]
set -euo pipefail
IMAGE="$1"; OUT="$2"; AGENT="$3"; INIT="$4"; PLATFORM="${5:-linux/arm64}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
cp "$AGENT" "$WORK/hotcell-agent"
cp "$INIT" "$WORK/init"

# Expose npm's OWN bundled node-gyp on PATH. The Node toolchain ships node-gyp
# inside npm, but installers that symlink node/npm/npx (e.g. the OpenCode provider
# benchmark's prepare()) leave bare `node-gyp` unreachable — so a native dep whose
# prebuilt doesn't match the guest (tree-sitter-powershell via node-gyp-build) falls
# back to `node-gyp rebuild` and crashes with `spawn node-gyp ENOENT`. This is a
# deterministic gap in a build environment, not a workload change: we point at the
# node-gyp npm already provides. Disclosed in the benchmark write-up.
cat > "$WORK/node-gyp" <<'NGYP'
#!/bin/sh
for j in /opt/node-*/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js \
         /usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js; do
  [ -f "$j" ] && exec node "$j" "$@"
done
exec npx -y node-gyp "$@"
NGYP

# 1. Export the target image's filesystem to a tar (no run; CMD irrelevant).
docker pull --platform "$PLATFORM" "$IMAGE" >/dev/null 2>&1 || true
CID="$(docker create --platform "$PLATFORM" "$IMAGE" 2>/dev/null \
    || docker create --platform "$PLATFORM" "$IMAGE" /bin/sh)"
docker export "$CID" > "$WORK/rootfs.tar"

# 2. Build the ext4 in an alpine builder (e2fsprogs; populate-from-dir). Inject
#    agent + init, ensure the read-only-root mountpoints exist, size to fit.
docker run --rm --platform "$PLATFORM" -v "$WORK:/work" alpine:3.20 sh -c '
  set -e
  apk add --no-cache e2fsprogs >/dev/null 2>&1
  mkdir -p /rootfs
  tar -xf /work/rootfs.tar -C /rootfs 2>/dev/null || true
  mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/run /rootfs/tmp /rootfs/workspace /rootfs/sbin
  cp /work/hotcell-agent /rootfs/sbin/hotcell-agent
  cp /work/init /rootfs/init
  mkdir -p /rootfs/usr/local/bin
  cp /work/node-gyp /rootfs/usr/local/bin/node-gyp
  chmod +x /rootfs/init /rootfs/sbin/hotcell-agent /rootfs/usr/local/bin/node-gyp
  SIZE_MB=$(( $(du -sm /rootfs | cut -f1) + 96 ))   # image contents + headroom
  rm -f /work/out.img
  mkfs.ext4 -q -F -L sbxroot -d /rootfs /work/out.img "${SIZE_MB}M"
'
mv "$WORK/out.img" "$OUT"
echo "converted $IMAGE -> $OUT"
