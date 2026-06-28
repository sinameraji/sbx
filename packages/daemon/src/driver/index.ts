import type { Config } from "../config.js";
import { AppleVzDriver } from "./applevz.js";
import { ContainerDriver } from "./container.js";
import { FirecrackerDriver } from "./firecracker.js";
import type { Driver } from "./types.js";

/** Known driver names, in preference/isolation order. */
export const DRIVER_NAMES = ["container", "firecracker", "applevz"] as const;

/**
 * Construct the runtime driver named by `config.driver` (`SBX_DRIVER`) — the
 * daemon's default. The `DriverRouter` calls `createNamedDriver` to build other
 * drivers on demand for per-sandbox isolation selection.
 */
export function createDriver(config: Config): Driver {
  return createNamedDriver(config.driver, config);
}

/**
 * Construct a specific runtime driver by name. The container driver is fully
 * built; the microVM drivers compile and report a clear "needs <host>" error
 * from `ping()` so a bad selection fails with guidance. Adding a real driver is
 * a one-line change here.
 */
export function createNamedDriver(name: string, config: Config): Driver {
  switch (name) {
    case "container":
      return new ContainerDriver(undefined, {
        enforce: config.egressEnforce,
        network: config.egressNetwork,
        subnet: config.egressSubnet,
        dns: config.egressDnsResolver,
      });
    case "firecracker":
      return new FirecrackerDriver();
    case "applevz":
      return new AppleVzDriver({
        helperPath: config.vzHelperPath,
        kernel: config.vzKernel,
        rootfs: config.vzRootfs,
        stateDir: config.vzStateDir,
        diskGb: config.vzDiskGb,
        imageCacheDir: config.vzImageCacheDir,
      });
    default:
      throw new Error(`unknown driver "${name}" (expected: ${DRIVER_NAMES.join(" | ")})`);
  }
}
