import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";
import { formatError } from "./util.js";

/** hotcell capacity — show host memory budget, what's committed, and how many more fit. */
export async function capacityCommand(
  _positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const c = await client.capacity();
    if (!c.enforced && c.memory.budgetMb === 0) {
      console.log("Admission control: off (host capacity unknown)");
      return 0;
    }
    const gb = (mb: number) => (mb / 1024).toFixed(1);
    console.log(`Admission:  ${c.enforced ? "enforce" : "off"}  (overcommit ${c.overcommit}x)`);
    console.log(
      `Memory:     ${gb(c.memory.committedMb)} / ${gb(c.memory.budgetMb)} GB committed` +
        `  (${gb(c.memory.availableMb)} GB free)`,
    );
    if (c.cpu.budget) {
      console.log(`CPU:        ${c.cpu.committed} / ${c.cpu.budget} cores committed`);
    }
    console.log(`Running:    ${c.running} sandboxes`);
    console.log(`Headroom:   ~${c.fits} more (at ${c.defaultReservationMb} MiB each)`);
    return 0;
  } catch (err) {
    console.error(`Failed to read capacity: ${formatError(err)}`);
    return 1;
  }
}
