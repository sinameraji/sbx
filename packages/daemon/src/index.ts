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
import { buildProviders, createEgressProxy } from "./proxy/egress.js";

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

  // Egress credential proxy (LLM gateway): injects provider keys into outbound
  // calls and meters them. Runs whenever a port is configured; routes 404 until
  // provider keys (SBX_PROVIDER_KEY_*) are set.
  const providers = buildProviders(config);
  const egress =
    config.egressPort > 0 ? createEgressProxy({ config, store, providers }) : undefined;
  egress?.listen(config.egressPort, config.egressHost, () => {
    log.info("egress proxy listening", {
      url: `http://${config.egressHost}:${config.egressPort}`,
      providers: Object.keys(providers).length ? Object.keys(providers).join(",") : "none configured",
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
    egress?.close();
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
