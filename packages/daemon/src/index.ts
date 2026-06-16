#!/usr/bin/env node
import { BackupRegistry } from "./backups.js";
import { loadConfig } from "./config.js";
import { ContainerDriver } from "./driver/container.js";
import { startReaper } from "./lifecycle.js";
import { configureLogger, log } from "./logger.js";
import { MetricsHistory, startSampler } from "./metrics.js";
import { configureTracing, stopTracing } from "./tracing.js";
import { SandboxStore } from "./store.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger({ level: config.logLevel, format: config.logFormat });
  configureTracing({
    serviceName: "sbd",
    otlpEndpoint: config.otlpEndpoint,
    ringSize: config.traceRing,
  });
  const driver = new ContainerDriver();
  const store = new SandboxStore(config.dbPath);
  const backups = new BackupRegistry(config.backupDir);
  const history = new MetricsHistory(config.metricsHistory);

  // Fail fast with a friendly message if the runtime backend is unreachable.
  try {
    await driver.ping();
  } catch (err) {
    log.error("container runtime (Docker) is not reachable", { error: String(err) });
    log.error("start Docker (or colima / Apple 'container') and retry");
    process.exit(1);
  }

  const server = createApiServer({ config, driver, store, backups, history });
  server.listen(config.port, config.host, () => {
    log.info("daemon listening", {
      url: `http://${config.host}:${config.port}`,
      driver: driver.name,
      image: config.defaultImage,
      auth: config.apiKey ? "on" : "off",
      otlp: config.otlpEndpoint || "off",
    });
  });

  const proxy = createProxyServer({ config, driver, store });
  proxy.listen(config.proxyPort, config.proxyHost, () => {
    log.info("preview proxy listening", {
      url: `http://${config.proxyHost}:${config.proxyPort}`,
      previews: `http://<id>-<port>.localhost:${config.proxyPort}/`,
    });
  });

  // Idle reaper: auto-pause sandboxes left idle past their sleepAfterMs.
  const reaper =
    config.reapIntervalMs > 0
      ? startReaper({ driver, store, intervalMs: config.reapIntervalMs })
      : undefined;

  // Metrics sampler: integrate per-sandbox CPU/mem usage for the cost meter.
  const sampler =
    config.metricsIntervalMs > 0
      ? startSampler({ driver, store, history, intervalMs: config.metricsIntervalMs })
      : undefined;

  const shutdown = () => {
    log.info("shutting down");
    if (reaper) clearInterval(reaper);
    if (sampler) clearInterval(sampler);
    stopTracing();
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
  log.error("fatal", { error: String(err?.stack ?? err) });
  process.exit(1);
});
