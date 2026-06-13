#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { ContainerDriver } from "./driver/container.js";
import { SandboxStore } from "./store.js";
import { createApiServer } from "./api/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const driver = new ContainerDriver();
  const store = new SandboxStore();

  // Fail fast with a friendly message if the runtime backend is unreachable.
  try {
    await driver.ping();
  } catch (err) {
    console.error(
      `[sbd] container runtime (Docker) is not reachable: ${String(err)}\n` +
        `      Start Docker (or colima / Apple 'container') and retry.`,
    );
    process.exit(1);
  }

  const server = createApiServer({ config, driver, store });
  server.listen(config.port, config.host, () => {
    console.log(
      `[sbd] sbx daemon listening on http://${config.host}:${config.port} ` +
        `(driver=${driver.name}, image=${config.defaultImage})`,
    );
  });

  const shutdown = () => {
    console.log("[sbd] shutting down");
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[sbd] fatal:", err);
  process.exit(1);
});
