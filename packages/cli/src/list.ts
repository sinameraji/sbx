import { SbxClient } from "@sbx/sdk";
import type { GlobalArgs } from "./cli.js";

export async function listCommand(globals: GlobalArgs): Promise<number> {
  const client = new SbxClient({ endpoint: globals.endpoint });

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

    console.log(
      `${padRight("ID", maxId)}  ${padRight("IMAGE", maxImage)}  STATUS   CREATED`,
    );
    for (const s of sandboxes) {
      console.log(
        `${padRight(s.id, maxId)}  ${padRight(s.image, maxImage)}  ${padRight(s.status, 7)}  ${s.createdAt}`,
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

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
