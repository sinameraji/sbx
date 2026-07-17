#!/bin/bash
# One-shot probe: which paths in the FC guest are writable + RAM-backed (tmpfs)?
# The work-spike needs a real resident (RAM) working set; /mnt failed (RO rootfs).
set +e
NODE=$(command -v node); BASE=localhost:4750
sudo pkill -9 -f "daemon/dist" 2>/dev/null; sudo pkill -9 -f firecracker 2>/dev/null; sleep 2
cd ~/hotcell
sudo -E env HOTCELL_DRIVER=firecracker HOTCELL_DB=:memory: HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc \
  setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld-probe.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 $BASE/healthz | grep -q ok && break; sleep 1; done
val(){ $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).id||""))}catch{}})'; }
exj(){ curl -s --max-time 120 -N -X POST "$BASE/sandboxes/$1/exec" -H 'content-type: application/json' -d "$2" | sed -n 's/^data: //p' | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{d.trim().split("\n").forEach(l=>{try{let e=JSON.parse(l);if(e.type=="stdout"||e.type=="stderr")process.stdout.write(e.data)}catch{}})})'; }
ID=$(curl -s --max-time 180 -X POST $BASE/sandboxes -H 'content-type: application/json' -d '{"image":"ubuntu:24.04","driver":"firecracker","memoryMb":2048,"cpus":1}' | val)
echo "guest=$ID"
exj "$ID" '{"command":"echo ===ROOT===; findmnt -no FSTYPE,OPTIONS / ; echo ===TMPFS_MOUNTS===; mount | grep -i tmpfs; echo ===SHM_DF===; df -m /dev/shm 2>/dev/null | tail -1; echo ===WRITE===; for p in /tmp /dev/shm /root /workspace /run; do (mkdir -p $p 2>/dev/null; if dd if=/dev/zero of=$p/_probe bs=1M count=50 2>/dev/null; then echo \"$p WRITABLE ($(findmnt -no FSTYPE --target $p 2>/dev/null))\"; rm -f $p/_probe; else echo \"$p FAIL\"; fi); done; echo ===REMOUNT_SHM===; mount -o remount,size=1900m /dev/shm 2>&1 && echo remount_ok && df -m /dev/shm | tail -1 || echo remount_FAILED"}'
curl -s -X DELETE "$BASE/sandboxes/$ID" >/dev/null 2>&1
echo PROBEDONE
