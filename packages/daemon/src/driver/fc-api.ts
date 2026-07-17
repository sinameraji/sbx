import { request } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * Firecracker control plane — the host-agnostic pieces of the `firecracker`
 * driver that compile and unit-test anywhere (no `/dev/kvm`): the VM
 * configuration the daemon PUTs over Firecracker's HTTP-API-over-unix-socket,
 * and the virtio-vsock UDS handshake the daemon uses to reach the in-guest agent.
 *
 * Only the *live boot* (spawning `firecracker`, the real vsock round-trip) needs
 * a KVM host; everything here is pure logic + thin I/O, exercised by `check:fc`.
 */

/** A single Firecracker API call (a PUT/PATCH of a JSON body to the API socket). */
export interface FcApiCall {
  method: "PUT" | "PATCH";
  path: string;
  body: Record<string, unknown>;
}

/** Inputs for a microVM's boot configuration. */
export interface FcVmSpec {
  kernelPath: string;
  /** Read-only base rootfs (becomes /dev/vda). */
  rootfsPath: string;
  /** Read-write per-sandbox workspace disk (becomes /dev/vdb). */
  workspacePath: string;
  vcpus: number;
  memMib: number;
  /** Host unix-socket path Firecracker exposes for guest vsock. */
  vsockUds: string;
  /** Guest context id (host is 2; guests use 3+). */
  guestCid?: number;
  /** Override the kernel command line (mainly for tests). */
  bootArgs?: string;
  /**
   * Opt-in guest networking. When set, the microVM gets an eth0 backed by the
   * host TAP device, auto-configured at boot via the kernel `ip=` param (no
   * in-guest tooling needed). Off by default — the flagship posture is a guest
   * with NO network device (egress only over vsock).
   */
  net?: FcNetSpec;
}

/** TAP-backed guest networking parameters (host side sets up the TAP + NAT). */
export interface FcNetSpec {
  /** Host TAP device name (e.g. `hctap0`). */
  tap: string;
  /** Guest MAC address. */
  guestMac: string;
  /** Guest IP (e.g. `172.16.0.2`). */
  guestIp: string;
  /** Gateway = the host TAP IP (e.g. `172.16.0.1`). */
  gatewayIp: string;
  /** Netmask (e.g. `255.255.255.0`). */
  mask: string;
}

/** Default kernel cmdline: serial console, no PCI, our agent as init, ro root. */
export const FC_DEFAULT_BOOT_ARGS =
  "console=ttyS0 reboot=k panic=1 pci=off init=/init root=/dev/vda ro";

/**
 * Build the ordered list of API calls that fully configure a microVM, ready to
 * `InstanceStart`. Pure — the driver applies these in order over the API socket.
 * The drive order matters: the root device is /dev/vda, the workspace /dev/vdb
 * (matching the shared guest init, which mounts /dev/vdb at /workspace).
 */
export function buildFcApiCalls(spec: FcVmSpec): FcApiCall[] {
  // With networking, auto-configure eth0 via the kernel `ip=` param at boot:
  //   ip=<guest>::<gw>:<mask>::eth0:off   (no in-guest tooling required).
  const baseArgs = spec.bootArgs ?? FC_DEFAULT_BOOT_ARGS;
  const bootArgs = spec.net
    ? `${baseArgs} ip=${spec.net.guestIp}::${spec.net.gatewayIp}:${spec.net.mask}::eth0:off`
    : baseArgs;
  const calls: FcApiCall[] = [
    {
      method: "PUT",
      path: "/boot-source",
      body: { kernel_image_path: spec.kernelPath, boot_args: bootArgs },
    },
    {
      method: "PUT",
      path: "/machine-config",
      body: { vcpu_count: spec.vcpus, mem_size_mib: spec.memMib, smt: false },
    },
    {
      method: "PUT",
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: spec.rootfsPath,
        is_root_device: true,
        is_read_only: true,
      },
    },
    {
      method: "PUT",
      path: "/drives/workspace",
      body: {
        drive_id: "workspace",
        path_on_host: spec.workspacePath,
        is_root_device: false,
        is_read_only: false,
      },
    },
    {
      method: "PUT",
      path: "/vsock",
      body: { guest_cid: spec.guestCid ?? 3, uds_path: spec.vsockUds },
    },
  ];
  if (spec.net) {
    calls.push({
      method: "PUT",
      path: "/network-interfaces/eth0",
      body: { iface_id: "eth0", host_dev_name: spec.net.tap, guest_mac: spec.net.guestMac },
    });
  }
  return calls;
}

/** The action that boots a configured VM. */
export const FC_START_ACTION: FcApiCall = {
  method: "PUT",
  path: "/actions",
  body: { action_type: "InstanceStart" },
};

/** The call that pauses a running VM's vCPUs (required before /snapshot/create). */
export const FC_PAUSE_VM: FcApiCall = {
  method: "PATCH",
  path: "/vm",
  body: { state: "Paused" },
};

/** Build the call that writes a Full snapshot (device state + guest RAM) to disk. */
export function buildSnapshotCreateCall(vmstatePath: string, memPath: string): FcApiCall {
  return {
    method: "PUT",
    path: "/snapshot/create",
    body: { snapshot_type: "Full", snapshot_path: vmstatePath, mem_file_path: memPath },
  };
}

/**
 * Build the call that restores a **fresh, unconfigured** VMM process from a
 * snapshot and resumes it immediately. The snapshot pins the original host paths
 * (kernel/rootfs/workspace drives, vsock UDS), so those files must still exist at
 * the same locations; Firecracker re-binds the vsock UDS listener itself on load.
 */
export function buildSnapshotLoadCall(vmstatePath: string, memPath: string): FcApiCall {
  return {
    method: "PUT",
    path: "/snapshot/load",
    body: {
      snapshot_path: vmstatePath,
      mem_backend: { backend_type: "File", backend_path: memPath },
      resume_vm: true,
    },
  };
}

/**
 * Parse Firecracker's vsock host→guest handshake reply. After the host connects
 * to the vsock UDS and writes `CONNECT <port>\n`, Firecracker replies with a line
 * `OK <hostPort>\n` on success, or `OK`-less text on failure. Returns the rest of
 * the buffer after the newline (which may already hold agent bytes) when the line
 * is present, or null if no complete line has arrived yet. Pure — unit-tested.
 */
export function parseVsockHandshake(buf: Buffer): { ok: boolean; line: string; leftover: Buffer } | null {
  const nl = buf.indexOf(0x0a);
  if (nl === -1) return null; // wait for a complete line
  const line = buf.subarray(0, nl).toString("utf8").trim();
  return { ok: /^OK\s+\d+/.test(line), line, leftover: buf.subarray(nl + 1) };
}

/** Thin client for Firecracker's HTTP API over its unix socket. */
export class FcApi {
  constructor(private readonly socketPath: string) {}

  /** Apply one API call; resolves on 2xx, rejects with the body otherwise. */
  call(c: FcApiCall): Promise<void> {
    const data = Buffer.from(JSON.stringify(c.body));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method: c.method,
          path: c.path,
          headers: { "content-type": "application/json", "content-length": data.length },
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve();
            else reject(new Error(`firecracker ${c.path} -> ${code}: ${body}`));
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }

  /** Apply a sequence of calls in order. */
  async applyAll(calls: FcApiCall[]): Promise<void> {
    for (const c of calls) await this.call(c);
  }
}

/**
 * Connect to a guest vsock port through Firecracker's UDS multiplexer: open the
 * UDS, write `CONNECT <port>\n`, await the `OK <port>` line, and hand back the
 * live socket plus any bytes that arrived after the handshake (often the agent's
 * Hello). The caller wires the socket into an `AgentConn`.
 */
export function fcVsockConnect(
  udsPath: string,
  port: number,
  timeoutMs = 15000,
): Promise<{ socket: Socket; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect(udsPath);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`firecracker vsock connect to :${port} timed out`));
    }, timeoutMs);
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d]);
      const parsed = parseVsockHandshake(buf);
      if (!parsed) return; // wait for the full line
      socket.off("data", onData);
      clearTimeout(timer);
      if (!parsed.ok) {
        socket.destroy();
        reject(new Error(`firecracker vsock handshake failed: "${parsed.line}"`));
        return;
      }
      resolve({ socket, leftover: parsed.leftover });
    };
    socket.on("connect", () => socket.write(`CONNECT ${port}\n`));
    socket.on("data", onData);
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
