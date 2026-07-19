import { HotcellClient } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

export async function listCommand(globals: GlobalArgs): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  try {
    const sandboxes = await client.list();
    if (sandboxes.length === 0) {
      console.log("No sandboxes.");
      return 0;
    }

    const maxId = Math.max(
      4,
      ...sandboxes.map((s) => s.id.length),
    );
    const maxImage = Math.max(
      5,
      ...sandboxes.map((s) => s.image.length),
    );
    // NAME column only when at least one sandbox is named (`create --name`).
    const named = sandboxes.some((s) => s.labels?.name);
    const maxName = named
      ? Math.max(4, ...sandboxes.map((s) => (s.labels?.name ?? "").length))
      : 0;

    console.log(
      `${padRight("ID", maxId)}  ${named ? padRight("NAME", maxName) + "  " : ""}${padRight("IMAGE", maxImage)}  STATUS   CREATED`,
    );
    for (const s of sandboxes) {
      console.log(
        `${padRight(s.id, maxId)}  ${named ? padRight(s.labels?.name ?? "—", maxName) + "  " : ""}${padRight(s.image, maxImage)}  ${padRight(s.status, 7)}  ${s.createdAt}`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`Failed to list sandboxes: ${formatError(err)}`);
    return 1;
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}
