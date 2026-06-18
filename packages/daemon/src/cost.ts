import type { Config } from "./config.js";
import type { CostBreakdown, SandboxUsage } from "./types.js";

const BYTES_PER_GB = 1e9;
const SECONDS_PER_HOUR = 3600;

/**
 * Translate cumulative usage into a cost breakdown using the configured rates.
 * CPU is exact (integrated vCPU-seconds), memory is integrated GB-seconds, and
 * egress is the preview-proxy bytes the sandbox has sent out. (Full internet
 * egress metering arrives with the Phase 3 egress credential proxy.)
 */
export function computeCost(usage: SandboxUsage, config: Config): CostBreakdown {
  const cpu = (usage.cpuSeconds / SECONDS_PER_HOUR) * config.costCpuPerHour;
  const memGbSeconds = usage.memByteSeconds / BYTES_PER_GB;
  const mem = (memGbSeconds / SECONDS_PER_HOUR) * config.costMemGbPerHour;
  const egress = (usage.egressBytes / BYTES_PER_GB) * config.costEgressPerGb;
  // LLM cost is the provider's own reported figure (e.g. OpenRouter usage.cost) —
  // the source of truth, not a rate we apply.
  const provider = usage.providerCost ?? 0;
  return { cpu, mem, egress, provider, total: cpu + mem + egress + provider };
}
