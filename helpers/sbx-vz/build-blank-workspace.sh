#!/usr/bin/env bash
# Build a blank, pre-formatted ext4 workspace image of <sizeMb> MiB. The driver
# clones this per sandbox (APFS copy-on-write) for /dev/vdb, so the guest only
# mounts it — never formats it. This makes the workspace work for images without
# mkfs.ext4 (e.g. debian-based python:3.11-slim) and removes a first-boot step.
#
# Sparse: a freshly mkfs'd ext4 only writes metadata, so the file is a few MiB on
# disk regardless of <sizeMb>.
#
# Usage: build-blank-workspace.sh <out.img> <sizeMb> [platform]
set -euo pipefail
OUT="$1"; SIZE_MB="$2"; PLATFORM="${3:-linux/arm64}"
DIR="$(cd "$(dirname "$OUT")" && pwd)"
BASE="$(basename "$OUT")"
docker run --rm --platform "$PLATFORM" -v "$DIR:/o" alpine:3.20 sh -c "
  set -e
  apk add --no-cache e2fsprogs >/dev/null 2>&1
  rm -f /o/'$BASE'
  mkfs.ext4 -q -F -L sbxwork -O ^has_journal /o/'$BASE' ${SIZE_MB}M
"
echo "built blank workspace $OUT (${SIZE_MB}M)"
