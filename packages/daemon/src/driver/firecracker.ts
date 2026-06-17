import { UnsupportedDriver } from "./unsupported.js";

/**
 * Firecracker microVM driver (Phase 3, Linux). Will give each sandbox a
 * hardware-isolated microVM (~5 MiB overhead, ~125 ms boot, FC snapshots for
 * warm-pool resume) behind the same `Driver` interface, with the in-sandbox
 * agent reached over vsock. Not built yet — it needs a Linux host with KVM
 * (`/dev/kvm`) and the firecracker binary, which this developer machine lacks.
 */
export class FirecrackerDriver extends UnsupportedDriver {
  readonly name = "firecracker";

  async ping(): Promise<void> {
    throw new Error(
      "the firecracker driver is not built yet — it needs a Linux host with KVM " +
        "(/dev/kvm) and the firecracker binary. Set SBX_DRIVER=container for now. " +
        "Tracked as Phase 3 in docs/plan.md.",
    );
  }
}
