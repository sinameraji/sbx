import type { Config } from "../config.js";
import { AppleVzDriver } from "./applevz.js";
import { ContainerDriver } from "./container.js";
import { FirecrackerDriver } from "./firecracker.js";
import type { Driver } from "./types.js";

/** Known driver names, in preference/isolation order. */
export const DRIVER_NAMES = ["container", "firecracker", "applevz"] as const;

/**
 * Construct the runtime driver selected by `config.driver` (`SBX_DRIVER`). The
 * container driver is the only built implementation today; the microVM drivers
 * compile and report a clear "needs <host>" error from `ping()` so the daemon
 * fails fast with guidance. Adding a real driver is a one-line change here.
 */
export function createDriver(config: Config): Driver {
  switch (config.driver) {
    case "container":
      return new ContainerDriver();
    case "firecracker":
      return new FirecrackerDriver();
    case "applevz":
      return new AppleVzDriver();
    default:
      throw new Error(
        `unknown SBX_DRIVER "${config.driver}" (expected: ${DRIVER_NAMES.join(" | ")})`,
      );
  }
}
