import { HotcellClient } from "@hotcell/sdk";
import type { GlobalArgs } from "./cli.js";

/** sb info — print daemon driver/providers/auth/cost configuration. */
export async function infoCommand(
  _positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const i = await client.info();
    console.log(`endpoint:  ${client.endpoint}`);
    console.log(`driver:    ${i.driver}  (available: ${i.drivers.join(", ")})`);
    console.log(`image:     ${i.defaultImage}`);
    console.log(`proxy:     :${i.proxyPort}   egress: :${i.egressPort}`);
    console.log(`providers: ${i.egressProviders.join(", ") || "(none configured)"}`);
    console.log(`auth:      ${i.auth ? "on" : "off"}   otlp: ${i.otlp ? "on" : "off"}`);
    console.log(
      `cost/hr:   cpu ${i.costCpuPerHour}  mem-GB ${i.costMemGbPerHour}  egress-GB ${i.costEgressPerGb}`,
    );
    return 0;
  } catch (err) {
    console.error(`Failed to reach daemon: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
