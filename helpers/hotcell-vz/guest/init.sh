#!/bin/sh
# hotcell-vz guest init (PID 1). Bootstraps a microVM guest: mounts the virtual
# filesystems, sets up the writable overlays + cgroups + the workspace disk, then
# execs the in-sandbox agent.
#
# The rootfs is mounted READ-ONLY and shared across every VM booting this image
# (so concurrent sandboxes never corrupt one another), so each writable path is
# either tmpfs (transient) or the per-sandbox /dev/vdb disk (persistent). This
# file is injected verbatim into the base rootfs by build-guest.sh (Alpine base)
# and convert-image.sh (arbitrary OCI image), so keep it POSIX-sh portable.
mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null
mount -t devtmpfs dev /dev 2>/dev/null
mkdir -p /dev/pts && mount -t devpts devpts /dev/pts 2>/dev/null  # PTYs (terminal)

# Read-only root: back the transient write paths with tmpfs so nothing touches
# the shared rootfs image. Process logs (/tmp/hotcell-proc-*.log) live on /tmp here.
# /var/tmp too — POSIX tools expect it writable, and on the shared RO rootfs any
# write there fails with EROFS (mkdir -p first: slim images may not ship it).
mkdir -p /var/tmp 2>/dev/null
for d in /tmp /run /var/tmp; do mount -t tmpfs tmpfs "$d" 2>/dev/null; done

# Loopback up so 127.0.0.1 (waitForPort, preview bridge to local servers) routes.
ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || true

# Opt-in NAT networking: the kernel `ip=` param auto-configures eth0 (IP+route)
# but not DNS. When an eth0 is present, write a resolver so name lookups work.
if [ -d /sys/class/net/eth0 ]; then
  printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /etc/resolv.conf 2>/dev/null || true
fi

# cgroup v2 (resource limits): mount the unified hierarchy if the kernel did not.
mkdir -p /sys/fs/cgroup 2>/dev/null
mountpoint -q /sys/fs/cgroup 2>/dev/null || mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null
# pidsLimit: the host injects hotcell.pids=<N> (legacy sbx.pids=<N>) on the kernel cmdline. Enable the pids
# controller, then run the agent (PID 1) in a leaf cgroup capped at N processes.
# Memory + CPU need no guest enforcement — the VM hard-caps them.
for tok in $(cat /proc/cmdline 2>/dev/null); do
  case "$tok" in hotcell.pids=*) PIDS_MAX="${tok#hotcell.pids=}";; sbx.pids=*) PIDS_MAX="${tok#sbx.pids=}";; esac
done
if [ -n "${PIDS_MAX:-}" ] && [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  echo +pids > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  mkdir -p /sys/fs/cgroup/sandbox
  echo "$PIDS_MAX" > /sys/fs/cgroup/sandbox/pids.max 2>/dev/null || true
  echo 1 > /sys/fs/cgroup/sandbox/cgroup.procs 2>/dev/null || true  # move PID 1 in
fi

# Workspace persistent disk (vdb): mount if already formatted (preserves data
# across stop/start); only format when the mount of an unformatted disk fails
# (first boot). The host pre-formats it for images without mkfs.ext4.
if [ -b /dev/vdb ]; then
  mount /dev/vdb /workspace 2>/dev/null || { mkfs.ext4 -q -F /dev/vdb 2>/dev/null && mount /dev/vdb /workspace; }
fi

echo hotcell-guest-init-ok
exec /sbin/hotcell-agent
