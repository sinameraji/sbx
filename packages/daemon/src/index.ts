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

/** A loopback bind host (unreachable from sandboxes on native-Linux dockerd). */
function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

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

  // Reconcile the egress bridge network at boot so a subnet collision (e.g. a
  // stale network from a pre-rename daemon) fails fast with an actionable message
  // instead of a 422 on the first create.
  if (config.egressEnforce && typeof driver.initEgress === "function") {
    await driver.initEgress();
  }

  const providers = buildProviders(config);
  const prices = loadModelPrices(config.modelPricesPath);
  // Native-Linux enforcement footgun: sandboxes reach the daemon via the bridge
  // gateway (host.docker.internal → ~172.17.0.1), so a loopback-only egress bind
  // is unreachable from them and every outbound call (npm, the LLM gateway) fails
  // with ECONNREFUSED. When enforcement is on, the platform is Linux, and the
  // operator hasn't pinned a host explicitly, bind 0.0.0.0 — access is still gated
  // by the per-sandbox egress token + the host firewall. Block the port at your
  // cloud firewall.
  const egressHostSet = !!(process.env.HOTCELL_EGRESS_HOST ?? process.env.SBX_EGRESS_HOST);
  const egressBindHost =
    config.egressEnforce && !egressHostSet && process.platform === "linux" && isLoopback(config.egressHost)
      ? "0.0.0.0"
      : config.egressHost;
  if (egressBindHost !== config.egressHost) {
    log.info("egress proxy binding 0.0.0.0 for native-Linux enforcement (token-gated; firewall the port)", {
      port: config.egressPort,
    });
  }
  const egress =
    config.egressPort > 0 ? createEgressProxy({ config, store, providers, prices }) : undefined;
  egress?.listen(config.egressPort, egressBindHost, () => {
    log.info("egress proxy listening", {
      url: `http://${egressBindHost}:${config.egressPort}`,
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
