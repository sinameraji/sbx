import { HotcellClient } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

export async function backupCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const id = positional[0];
  if (!id) {
    console.error("Usage: hotcell backup <id>");
    return 1;
  }

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    const info = await sandbox.createBackup();
    console.log(`Backed up ${id} -> ${info.backupId} (${info.bytes} bytes).`);
    return 0;
  } catch (err) {
    console.error(`Failed to create backup: ${formatError(err)}`);
    return 1;
  }
}

export async function restoreCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const [id, backupId] = positional;
  if (!id || !backupId) {
    console.error("Usage: hotcell restore <id> <backupId>");
    return 1;
  }

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    await sandbox.restoreBackup(backupId);
    console.log(`Restored ${id} from backup ${backupId}.`);
    return 0;
  } catch (err) {
    console.error(`Failed to restore backup: ${formatError(err)}`);
    return 1;
  }
}

export async function backupsCommand(
  positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const id = positional[0];
    const backups = id
      ? await (await client.getSandbox(id)).listBackups()
      : await client.listBackups();
    if (backups.length === 0) {
      console.log(id ? `No backups for ${id}.` : "No backups.");
      return 0;
    }
    for (const b of backups) {
      console.log(`${b.backupId}\t${b.sandboxId}\t${b.bytes}B\t${b.createdAt}`);
    }
    return 0;
  } catch (err) {
    console.error(`Failed to list backups: ${formatError(err)}`);
    return 1;
  }
}
