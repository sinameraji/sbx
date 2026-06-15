#!/usr/bin/env node
/**
 * sb — CLI for sbx, the self-hostable agent sandbox platform.
 *
 * Usage:
 *   sb run "<command>"          create a sandbox, run a command, destroy it
 *   sb ls                       list sandboxes
 *   sb rm <id>                  destroy a sandbox
 */

import { cli } from "./cli.js";

cli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
