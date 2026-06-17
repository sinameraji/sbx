import { UnsupportedDriver } from "./unsupported.js";

/**
 * Apple Virtualization.framework microVM driver (Phase 3, macOS). Will give each
 * sandbox a VM-grade isolated guest on Apple silicon behind the same `Driver`
 * interface, with the in-sandbox agent reached over vsock. Not built yet — it
 * needs a native (Swift/ObjC bridge) helper using Virtualization.framework, which
 * Node cannot call directly.
 */
export class AppleVzDriver extends UnsupportedDriver {
  readonly name = "applevz";

  async ping(): Promise<void> {
    throw new Error(
      "the applevz driver is not built yet — it needs macOS Virtualization.framework " +
        "via a native helper. Set SBX_DRIVER=container for now. " +
        "Tracked as Phase 3 in docs/plan.md.",
    );
  }
}
