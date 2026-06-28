#!/usr/bin/env node
import { BackupRegistry } from "./backups.js";
import { Capacity } from "./capacity.js";
import { loadConfig } from "./config.js";
import { DriverRouter } from "./driver/router.js";
import { startReaper } from "./lifecycle.js";
import { configureLogger, log } from "./logger.js";
import { MetricsHistory, startSampler } from "./metrics.js";
import { configureTracing, stopTracing } from "./tracing.js";
import { SandboxStore } from "./store.js";
import { createApiServer } from "./api/server.js";
import { createProxyServer } from "./proxy/server.js";
import { buildProviders, createEgressProxy } from "./proxy/egress.js";
import { loadModelPrices } from "./pricing.js";
import { ensureEgressFirewall } from "./net/firewall.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger({ level: config.logLevel, format: config.logFormat });
  configureTracing({
    serviceName: "sbd",
    otlpEndpoint: config.otlpEndpoint,
    ringSize: config.traceRing,
  });
  const store = new SandboxStore(config.dbPath);
  // Per-sandbox driver router: dispatches each sandbox's ops to the runtime
  // driver it was created with (container ↔ applevz), defaulting to SBX_DRIVER.
  const driver = new DriverRouter(config, store, config.driver);
  const backups = new BackupRegistry(config.backupDir);
  const history = new MetricsHistory(config.metricsHistory);

  // Fail fast with a friendly message if the selected driver isn't available
  // (Docker not running, or a microVM driver requested without host support).
  try {
    await driver.ping();
  } catch (err) {
    log.error(`driver "${driver.name}" is not available`, { error: String(err) });
    if (driver.name === "container") {
      log.error("start Docker (or colima / Apple 'container') and retry");
    }
    process.exit(1);
  }

  // Host capacity for the meter + admission control (best-effort detection).
  const host = await driver.hostInfo().catch(() => null);
  const capacity = new Capacity(store, config, host, history);
  if (host) {
    log.info("host capacity", {
      memoryMb: host.memoryMb,
      cpus: host.cpus,
      admission: capacity.enforced ? "enforce" : "off",
    });
  }

  const server = createApiServer({ config, driver, store, backups, history, capacity });
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
  // Install the host default-deny egress firewall (Linux + SBX_EGRESS_ENFORCE only;
  // advisory no-op otherwise). Best-effort: logs and continues if it can't.
  await ensureEgressFirewall(config);

  const providers = buildProviders(config);
  const prices = loadModelPrices(config.modelPricesPath);
  const egress =
    config.egressPort > 0 ? createEgressProxy({ config, store, providers, prices }) : undefined;
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

  const shutdown = async () => {
    log.info("shutting down");
    if (reaper) clearInterval(reaper);
    if (sampler) clearInterval(sampler);
    await driver.shutdown().catch(() => {}); // tear down the VZ warm pool, if any
    stopTracing();
    egress?.close();
    proxy.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error("fatal", { error: String(err?.stack ?? err) });
  process.exit(1);
});
