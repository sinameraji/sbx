/**
 * Firecracker host-agnostic check. Exercises the pieces of the `firecracker`
 * driver that need no `/dev/kvm` — the API-call builders, the vsock CONNECT
 * handshake parser, and the driver's fail-fast `ping`/`hostInfo` — so the
 * Linux-specific code is validated on any host (incl. this Mac / CI). The live
 * boot is gated behind `smoke:fc` on a KVM box. Run: `npm run check:fc`.
 */
import assert from "node:assert/strict";
import {
  buildFcApiCalls,
  FC_DEFAULT_BOOT_ARGS,
  FC_START_ACTION,
  parseVsockHandshake,
} from "./driver/fc-api.js";
import { FirecrackerDriver } from "./driver/firecracker.js";

let passed = 0;
const ok = (l: string) => {
  passed++;
  console.log(`  ✓ ${l}`);
};

async function main(): Promise<void> {
  // 1. API calls fully configure a VM in the right order with the right shapes.
  const calls = buildFcApiCalls({
    kernelPath: "/k/vmlinux",
    rootfsPath: "/k/rootfs.img",
    workspacePath: "/k/ws.img",
    vcpus: 2,
    memMib: 512,
    vsockUds: "/k/v.sock",
  });
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/boot-source", "/machine-config", "/drives/rootfs", "/drives/workspace", "/vsock"],
    "API calls cover boot/machine/drives/vsock in order",
  );
  const boot = calls[0]!.body as { kernel_image_path: string; boot_args: string };
  assert.equal(boot.kernel_image_path, "/k/vmlinux");
  assert.equal(boot.boot_args, FC_DEFAULT_BOOT_ARGS);
  const mc = calls[1]!.body as { vcpu_count: number; mem_size_mib: number };
  assert.equal(mc.vcpu_count, 2);
  assert.equal(mc.mem_size_mib, 512);
  // The root device is /dev/vda (ro), the workspace /dev/vdb (rw) — matches the
  // shared guest init that mounts /dev/vdb at /workspace.
  const rootDrive = calls[2]!.body as { is_root_device: boolean; is_read_only: boolean };
  assert.equal(rootDrive.is_root_device, true);
  assert.equal(rootDrive.is_read_only, true);
  const wsDrive = calls[3]!.body as { is_root_device: boolean; is_read_only: boolean };
  assert.equal(wsDrive.is_root_device, false);
  assert.equal(wsDrive.is_read_only, false);
  const vsock = calls[4]!.body as { uds_path: string; guest_cid: number };
  assert.equal(vsock.uds_path, "/k/v.sock");
  assert.equal(vsock.guest_cid, 3);
  ok("buildFcApiCalls: correct order, shapes, and vda(ro)/vdb(rw) drive layout");

  assert.equal((FC_START_ACTION.body as { action_type: string }).action_type, "InstanceStart");
  ok("FC_START_ACTION boots the VM");

  // 2. Custom boot args (e.g. the pidsLimit cmdline) pass through.
  const withPids = buildFcApiCalls({
    kernelPath: "/k",
    rootfsPath: "/r",
    workspacePath: "/w",
    vcpus: 1,
    memMib: 256,
    vsockUds: "/v",
    bootArgs: `${FC_DEFAULT_BOOT_ARGS} sbx.pids=64`,
  });
  assert.match((withPids[0]!.body as { boot_args: string }).boot_args, /sbx\.pids=64/);
  ok("custom boot args (pidsLimit cmdline) flow through");

  // 3. vsock handshake parser: incomplete → null; OK line → split leftover; bad → not ok.
  assert.equal(parseVsockHandshake(Buffer.from("OK 1024")), null, "no newline yet → null");
  const okParse = parseVsockHandshake(Buffer.from("OK 1024\nHELLOBYTES"));
  assert.ok(okParse && okParse.ok, "OK line parses as ok");
  assert.equal(okParse!.leftover.toString(), "HELLOBYTES", "post-handshake bytes preserved");
  const badParse = parseVsockHandshake(Buffer.from("CONNECTION RESET\n"));
  assert.ok(badParse && !badParse.ok, "non-OK line parses as not ok");
  ok("vsock CONNECT handshake parser: incomplete / ok+leftover / failure");

  // 4. Driver fail-fast on a non-KVM host (this Mac): ping names /dev/kvm.
  const driver = new FirecrackerDriver({
    fcBin: "firecracker",
    kernel: "/nonexistent/vmlinux",
    rootfs: "helpers/sbx-vz/guest/rootfs.img",
    stateDir: "/tmp/sbx-fc-check",
    diskGb: 8,
    imageCacheDir: "/tmp/sbx-fc-check/images",
  });
  assert.equal(driver.name, "firecracker");
  if (process.platform !== "linux") {
    await assert.rejects(() => driver.ping(), /\/dev\/kvm/, "ping fails fast with a /dev/kvm message off-KVM");
    ok("ping fails fast naming /dev/kvm (host without KVM)");
  } else {
    ok("ping skipped (on Linux — may have /dev/kvm; live boot is smoke:fc)");
  }

  // 5. hostInfo works anywhere (os fallback when /proc is absent).
  const host = await driver.hostInfo();
  assert.ok(host.memoryMb > 0, "hostInfo reports memory");
  assert.ok(host.cpus > 0, "hostInfo reports cpus");
  ok(`hostInfo: ${host.memoryMb}MB / ${host.cpus} cpus`);

  console.log(`\nfc-check: ${passed} checks passed (host-agnostic; live boot gated on KVM)`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("fc-check FAILED:", err);
    process.exit(1);
  },
);
