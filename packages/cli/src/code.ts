import { HotcellClient, type CodeLanguage } from "@hotcell/sdk";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

export async function runCodeCommand(
  positional: string[],
  globals: GlobalArgs,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const [id, code] = positional;
  if (!id || !code) {
    console.error('Usage: hotcell run-code <id> "<code>" [--lang python|javascript]');
    return 1;
  }

  const lang = typeof flags.lang === "string" ? flags.lang : "python";
  if (lang !== "python" && lang !== "javascript") {
    console.error("--lang must be 'python' or 'javascript'");
    return 1;
  }

  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });
  try {
    const sandbox = await client.getSandbox(id);
    const result = await sandbox.runCode(code, { language: lang as CodeLanguage });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    for (const out of result.results) {
      process.stdout.write(out.text + "\n");
    }
    if (result.error) {
      process.stderr.write(result.error + "\n");
      return 1;
    }
    return 0;
  } catch (err) {
    console.error(`Failed to run code: ${formatError(err)}`);
    return 1;
  }
}
