import type { Config } from "./config.js";
import type { CostBreakdown, SandboxUsage } from "./types.js";

const BYTES_PER_GB = 1e9;
const SECONDS_PER_HOUR = 3600;

/**
 * Translate cumulative usage into a cost breakdown using the configured rates.
 * CPU is exact (integrated vCPU-seconds); memory is integrated GB-seconds. Egress
 * billing is a future addition once the proxy meters per-sandbox bytes.
 */
export function computeCost(usage: SandboxUsage, config: Config): CostBreakdown {
  const cpu = (usage.cpuSeconds / SECONDS_PER_HOUR) * config.costCpuPerHour;
  const memGbSeconds = usage.memByteSeconds / BYTES_PER_GB;
  const mem = (memGbSeconds / SECONDS_PER_HOUR) * config.costMemGbPerHour;
  return { cpu, mem, total: cpu + mem };
}
