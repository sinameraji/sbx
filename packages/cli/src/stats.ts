import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";

/** sb stats <id> — print live resource usage and accumulated cost. */
export async function statsCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: sb stats <id>");
    return 1;
  }

  const client = new SbxClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    const info = sandbox.getInfo();
    const m = await sandbox.metrics();
    console.log(`Sandbox ${id} (${m.status})`);
    const lim = info.limits ?? {};
    if (lim.memoryMb || lim.cpus || lim.pidsLimit) {
      const parts: string[] = [];
      if (lim.cpus) parts.push(`${lim.cpus} cpu`);
      if (lim.memoryMb) parts.push(`${lim.memoryMb} MB`);
      if (lim.pidsLimit) parts.push(`${lim.pidsLimit} pids`);
      console.log(`  Limits: ${parts.join(", ")}`);
    } else {
      console.log("  Limits: none (unlimited)");
    }
    if (m.live) {
      const memMb = (m.live.memBytes / 1e6).toFixed(1);
      const limitMb =
        m.live.memLimitBytes > 0
          ? (m.live.memLimitBytes / 1e6).toFixed(0)
          : "∞";
      console.log(`  CPU:  ${m.live.cpuPercent.toFixed(1)}% of ${m.live.onlineCpus} cpu`);
      console.log(`  Mem:  ${memMb} MB / ${limitMb} MB`);
      console.log(
        `  Net:  ↓ ${(m.live.netRxBytes / 1e6).toFixed(2)} MB  ↑ ${(m.live.netTxBytes / 1e6).toFixed(2)} MB`,
      );
      console.log(`  PIDs: ${m.live.pids}`);
    } else {
      console.log("  (not running — no live stats)");
    }
    console.log(
      `  Usage: ${m.usage.cpuSeconds.toFixed(1)} vCPU-s, ${(m.usage.memByteSeconds / 1e9).toFixed(1)} GB-s, ${(m.usage.egressBytes / 1e6).toFixed(2)} MB egress`,
    );
    if (m.usage.providerCalls > 0) {
      console.log(
        `  LLM:   ${m.usage.providerCalls} calls, ${m.usage.providerTokensIn} in + ${m.usage.providerTokensOut} out tokens, $${m.usage.providerCost.toFixed(4)}`,
      );
    }
    console.log(
      `  Cost:  ${m.cost.total.toFixed(6)} (cpu ${m.cost.cpu.toFixed(6)} + mem ${m.cost.mem.toFixed(6)} + egress ${m.cost.egress.toFixed(6)} + llm ${m.cost.provider.toFixed(6)})`,
    );
    return 0;
  } catch (err) {
    console.error(`Failed to get metrics: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
