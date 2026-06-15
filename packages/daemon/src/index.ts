#!/usr/bin/env node
import { BackupRegistry } from "./backups.js";
import { loadConfig } from "./config.js";
import { ContainerDriver } from "./driver/container.js";
import { startReaper } from "./lifecycle.js";
import { SandboxStore } from "./store.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const driver = new ContainerDriver();
  const store = new SandboxStore(config.dbPath);
  const backups = new BackupRegistry(config.backupDir);

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

  const server = createApiServer({ config, driver, store, backups });
  server.listen(config.port, config.host, () => {
    console.log(
      `[sbd] sbx daemon listening on http://${config.host}:${config.port} ` +
        `(driver=${driver.name}, image=${config.defaultImage})`,
    );
  });

  const proxy = createProxyServer({ config, driver, store });
  proxy.listen(config.proxyPort, config.proxyHost, () => {
    console.log(
      `[sbd] preview proxy listening on http://${config.proxyHost}:${config.proxyPort} ` +
        `(previews at http://<id>-<port>.localhost:${config.proxyPort}/)`,
    );
  });

  // Idle reaper: auto-pause sandboxes left idle past their sleepAfterMs.
  const reaper =
    config.reapIntervalMs > 0
      ? startReaper({ driver, store, intervalMs: config.reapIntervalMs })
      : undefined;

  const shutdown = () => {
    console.log("[sbd] shutting down");
    if (reaper) clearInterval(reaper);
    proxy.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[sbd] fatal:", err);
  process.exit(1);
});
