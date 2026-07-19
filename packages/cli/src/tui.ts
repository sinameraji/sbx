import { createInterface } from "node:readline";
import { HotcellClient, type SandboxInfo } from "@hotcell/sdk";
import { terminalCommand } from "./terminal.js";
import { formatError } from "./util.js";
import type { GlobalArgs } from "./cli.js";

/**
 * hotcell tui — a full-screen fleet monitor + control panel in the terminal.
 *
 * The operational counterpart to the web dashboard, for the dev who lives in a
 * shell (or is SSH'd into their box). It rides entirely on the existing REST
 * surface: `GET /sandboxes` for the fleet, `GET /sandboxes/:id/metrics` for live
 * usage, the lifecycle POSTs for actions, and the WebSocket PTY (reused via
 * `terminalCommand`) for attach. No TUI framework — hand-rolled ANSI keeps the
 * CLI dependency-free like the rest of the package.
 *
 * Keys: ↑/↓ (or j/k) move · ←/→ switch detail view · ⏎ attach a shell ·
 *       p pause · r resume · d destroy · c create · ? help · q quit.
 */

const REFRESH_MS = 2000;
const METRICS_CONCURRENCY = 8;

// ANSI 256-colour palette (matches the demo/video conventions: green = healthy
// hotcell, red = bad, dim = chrome).
const ESC = "\x1b";
const c = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[38;5;244m`,
  green: `${ESC}[38;5;114m`,
  red: `${ESC}[38;5;203m`,
  yellow: `${ESC}[38;5;179m`,
  cyan: `${ESC}[38;5;80m`,
  white: `${ESC}[38;5;253m`,
  invert: `${ESC}[7m`,
};

/** Live metrics shape (subset of the daemon's /metrics response we render). */
interface LiveMetrics {
  status: string;
  live: {
    cpuPercent: number;
    memBytes: number;
    memLimitBytes: number;
    onlineCpus: number;
    pids: number;
  } | null;
  usage: { egressBytes: number; providerCalls: number; providerCost: number };
  cost: { total: number };
}

interface Capacity {
  enforced: boolean;
  memory: { committedMb: number; budgetMb: number; availableMb: number };
  running: number;
  fits: number;
}

type Mode = "list" | "help" | "confirm";

export async function tuiCommand(
  _positional: string[],
  globals: GlobalArgs,
): Promise<number> {
  if (!process.stdout.isTTY) {
    console.error("hotcell tui needs an interactive terminal (stdout is not a TTY).");
    return 1;
  }
  const client = new HotcellClient({ endpoint: globals.endpoint, apiKey: globals.apiKey });

  // --- state -------------------------------------------------------------
  let rows: SandboxInfo[] = [];
  const metrics = new Map<string, LiveMetrics | null>();
  let capacity: Capacity | null = null;
  // Selection is tracked by sandbox ID, not row index: refresh() re-sorts (a
  // paused sandbox sinks below the running ones), so an index would drift onto a
  // different sandbox between frames — dangerous when `d` destroys the selection.
  let selectedId: string | null = null;
  let detailView = 0; // 0 overview · 1 metrics · 2 egress
  const detailNames = ["overview", "metrics", "egress"];
  let mode: Mode = "list";
  let status = ""; // transient footer message
  let lastError = "";
  let refreshing = false;
  let stopped = false;
  // While attached to a PTY (or showing the create prompt) the background refresh
  // timer must NOT paint TUI frames — otherwise the fleet screen flashes back over
  // the live shell every REFRESH_MS (looked like a race). Guards render + refresh.
  let suspended = false;
  let confirmAction: (() => Promise<void>) | null = null;
  let confirmPrompt = "";

  // --- terminal setup / teardown ----------------------------------------
  const out = process.stdout;
  const stdin = process.stdin;

  const enterScreen = () => {
    out.write(`${ESC}[?1049h${ESC}[?25l`); // alt-screen + hide cursor
  };
  const leaveScreen = () => {
    out.write(`${ESC}[?25h${ESC}[?1049l`); // show cursor + restore screen
  };

  let onData: ((b: Buffer) => void) | null = null;
  const attachInput = (handler: (b: Buffer) => void) => {
    onData = handler;
    try { stdin.setRawMode?.(true); } catch {}
    stdin.resume();
    stdin.on("data", handler);
    out.on("resize", render);
  };
  const detachInput = () => {
    if (onData) stdin.off("data", onData);
    out.off("resize", render);
    try { stdin.setRawMode?.(false); } catch {}
    stdin.pause();
    onData = null;
  };

  // Safety net: never leave the user's terminal in alt-screen/hidden-cursor
  // state if we crash.
  const restore = () => {
    detachInput();
    leaveScreen();
  };
  process.on("exit", restore);

  // --- rendering ---------------------------------------------------------
  // `|| fallback` (not `??`) on purpose: some terminals/pty setups report a
  // 0 winsize, and a 0 here would blank the whole frame.
  const width = () => out.columns || 80;
  const height = () => out.rows || 24;

  const fit = (s: string, w: number) => {
    // Truncate/pad a *visible* string to width w (assumes no ANSI inside).
    if (s.length > w) return s.slice(0, Math.max(0, w - 1)) + "…";
    return s + " ".repeat(w - s.length);
  };
  const shortId = (id: string) => id.slice(0, 12);
  // Binary units (GiB/MiB), matching the header's capacity math — decimal GB here
  // made per-row totals (8.3G) exceed the header's host total (7.8G).
  const human = (bytes: number) =>
    bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}G` : `${(bytes / 1024 ** 2).toFixed(0)}M`;
  const uptime = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms) || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  };
  const dot = (st: string) =>
    st === "running" ? `${c.green}●${c.reset}`
    : st === "paused" ? `${c.yellow}●${c.reset}`
    : st === "stopped" ? `${c.dim}○${c.reset}`
    : `${c.red}●${c.reset}`;

  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  // Selection helpers (id-based).
  const selIndex = () => {
    const i = rows.findIndex((r) => r.id === selectedId);
    return i === -1 ? 0 : i;
  };
  const current = () => rows.find((r) => r.id === selectedId);
  const moveSel = (delta: number) => {
    if (rows.length === 0) return;
    const next = Math.min(rows.length - 1, Math.max(0, selIndex() + delta));
    selectedId = rows[next].id;
  };

  function renderHeader(): void {
    const w = width();
    let cap = `${c.dim}capacity unknown${c.reset}`;
    if (capacity && (capacity.enforced || capacity.memory.budgetMb > 0)) {
      const g = (mb: number) => (mb / 1024).toFixed(1);
      cap = `${c.dim}mem${c.reset} ${g(capacity.memory.committedMb)}/${g(capacity.memory.budgetMb)}G ${c.dim}· ~${capacity.fits} fit${c.reset}`;
    }
    const running = rows.filter((r) => r.status === "running").length;
    const left = `${c.bold}${c.cyan}hotcell${c.reset} ${c.dim}·${c.reset} ${rows.length} sandbox${rows.length === 1 ? "" : "es"} ${c.dim}(${running} running)${c.reset}`;
    const clock = new Date().toTimeString().slice(0, 8);
    // left … cap … clock, padded across the width (approximate; ANSI-aware pad).
    push(` ${left}   ${cap}   ${c.dim}${clock}${c.reset}`);
    push(` ${c.dim}${"─".repeat(Math.max(0, w - 2))}${c.reset}`);
  }

  function renderList(bodyRows: number): void {
    const w = width();
    // Column widths: dot(1) id(12) image(flex) cpu(7) mem(11) up(6) cost(10)
    const idW = 12, cpuW = 7, memW = 11, upW = 6, costW = 10;
    const imgW = Math.max(8, w - (3 + idW + 1 + cpuW + 1 + memW + 1 + upW + 1 + costW + 2));
    const head = ` ${c.dim}  ${fit("ID", idW)} ${fit("IMAGE", imgW)} ${fit("CPU", cpuW)} ${fit("MEM", memW)} ${fit("UP", upW)} ${fit("COST", costW)}${c.reset}`;
    push(head);

    if (rows.length === 0) {
      push("");
      push(`   ${c.dim}no sandboxes. press ${c.reset}${c.bold}c${c.reset}${c.dim} to create one, or ${c.reset}${c.bold}q${c.reset}${c.dim} to quit.${c.reset}`);
      return;
    }

    // Scroll window around the selection.
    const cur = selIndex();
    const visible = Math.max(1, bodyRows - 1);
    let start = 0;
    if (cur >= visible) start = cur - visible + 1;
    const end = Math.min(rows.length, start + visible);

    for (let i = start; i < end; i++) {
      const r = rows[i];
      const m = metrics.get(r.id);
      const sel = r.id === selectedId;
      const cpu = m?.live ? `${m.live.cpuPercent.toFixed(0)}%` : r.status === "running" ? "…" : "—";
      const mem = m?.live
        ? `${human(m.live.memBytes)}${m.live.memLimitBytes > 0 ? "/" + human(m.live.memLimitBytes) : ""}`
        : (r.status === "paused" ? "paused" : r.status === "stopped" ? "stopped" : "—");
      const cost = m ? `$${m.cost.total.toFixed(4)}` : "—";
      const marker = sel ? `${c.bold}${c.cyan}▸${c.reset}` : " ";
      const body = `${marker}${dot(r.status)} ${fit(shortId(r.id), idW)} ${fit(r.image, imgW)} ${fit(cpu, cpuW)} ${fit(mem, memW)} ${fit(uptime(r.createdAt), upW)} ${fit(cost, costW)}`;
      push(sel ? ` ${c.invert}${stripForInvert(body)}${c.reset}` : ` ${body}`);
    }
  }

  // For the selected (inverted) row, ANSI colour codes fight the invert; render
  // that one line uncoloured so the highlight is clean.
  function stripForInvert(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
  }

  function renderDetail(): void {
    const w = width();
    push(` ${c.dim}${"─".repeat(Math.max(0, w - 2))}${c.reset}`);
    const tabs = detailNames
      .map((n, i) => (i === detailView ? `${c.bold}${c.cyan}${n}${c.reset}` : `${c.dim}${n}${c.reset}`))
      .join(`${c.dim} · ${c.reset}`);
    push(` ${tabs}   ${c.dim}(←/→)${c.reset}`);
    const r = current();
    if (!r) { push(`   ${c.dim}—${c.reset}`); return; }
    const m = metrics.get(r.id);
    if (detailView === 0) {
      push(`   ${c.dim}id${c.reset}      ${r.id}`);
      push(`   ${c.dim}image${c.reset}   ${r.image}`);
      push(`   ${c.dim}status${c.reset}  ${dot(r.status)} ${r.status}`);
      const lim = r.limits ?? {};
      const lparts = [
        lim.cpus ? `${lim.cpus} cpu` : null,
        lim.memoryMb ? `${lim.memoryMb} MB` : null,
        lim.pidsLimit ? `${lim.pidsLimit} pids` : null,
      ].filter(Boolean);
      push(`   ${c.dim}limits${c.reset}  ${lparts.length ? lparts.join(", ") : "unlimited"}`);
      const labels = Object.entries(r.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
      if (labels) push(`   ${c.dim}labels${c.reset}  ${labels}`);
    } else if (detailView === 1) {
      if (m?.live) {
        push(`   ${c.dim}cpu${c.reset}   ${m.live.cpuPercent.toFixed(1)}% of ${m.live.onlineCpus} cpu`);
        push(`   ${c.dim}mem${c.reset}   ${human(m.live.memBytes)}${m.live.memLimitBytes > 0 ? " / " + human(m.live.memLimitBytes) : ""}`);
        push(`   ${c.dim}pids${c.reset}  ${m.live.pids}`);
        push(`   ${c.dim}cost${c.reset}  $${m.cost.total.toFixed(6)}`);
      } else {
        push(`   ${c.dim}(not running — no live metrics)${c.reset}`);
      }
    } else {
      if (m) {
        push(`   ${c.dim}egress${c.reset}  ${(m.usage.egressBytes / 1e6).toFixed(2)} MB`);
        push(`   ${c.dim}llm${c.reset}     ${m.usage.providerCalls} calls · $${m.usage.providerCost.toFixed(4)}`);
      } else {
        push(`   ${c.dim}(no metrics yet)${c.reset}`);
      }
    }
  }

  function renderFooter(): void {
    const w = width();
    // The transient status/error gets its OWN line above the separator, so the
    // key legend below is never overwritten by a "paused …" note. Blank when idle,
    // which keeps the footer a stable height.
    const note = lastError ? `${c.red}${lastError}${c.reset}` : status ? `${c.green}${status}${c.reset}` : "";
    push(note ? ` ${note}` : "");
    push(` ${c.dim}${"─".repeat(Math.max(0, w - 2))}${c.reset}`);
    if (mode === "confirm") {
      push(` ${c.yellow}${confirmPrompt}${c.reset} ${c.dim}[y/n]${c.reset}`);
      return;
    }
    push(` ${c.dim}↑/↓${c.reset} move  ${c.dim}←/→${c.reset} view  ${c.bold}⏎${c.reset} attach  ${c.bold}p${c.reset} pause  ${c.bold}r${c.reset} resume  ${c.bold}d${c.reset} destroy  ${c.bold}c${c.reset} create  ${c.bold}?${c.reset} help  ${c.bold}q${c.reset} quit`);
  }

  function renderHelp(): void {
    lines.length = 0;
    push("");
    push(`  ${c.bold}${c.cyan}hotcell tui — help${c.reset}`);
    push("");
    const items: [string, string][] = [
      ["↑ / ↓  (j / k)", "move the selection"],
      ["← / →", "switch the detail view (overview · metrics · egress)"],
      ["Enter", "attach an interactive shell to the selected sandbox"],
      ["p", "pause the selected sandbox (memory snapshot on microVMs)"],
      ["r", "resume a paused/stopped sandbox"],
      ["d", "destroy the selected sandbox (asks to confirm)"],
      ["c", "create a new sandbox (prompts for image/driver/memory)"],
      ["g / G", "jump to first / last"],
      ["?", "toggle this help"],
      ["q  (Ctrl-C)", "quit"],
    ];
    for (const [k, v] of items) push(`   ${c.bold}${fit(k, 16)}${c.reset}  ${c.dim}${v}${c.reset}`);
    push("");
    push(`   ${c.dim}Refreshes every ${REFRESH_MS / 1000}s. Reads GET /sandboxes + /metrics; actions are the${c.reset}`);
    push(`   ${c.dim}same REST calls as the flat CLI. Attach reuses the WebSocket PTY.${c.reset}`);
    push("");
    push(`   ${c.dim}press ${c.reset}${c.bold}?${c.reset}${c.dim} or ${c.reset}${c.bold}Esc${c.reset}${c.dim} to close${c.reset}`);
  }

  function render(): void {
    if (stopped || suspended) return;
    lines.length = 0;
    const h = height();
    if (mode === "help") {
      renderHelp();
    } else {
      renderHeader(); // 2 lines
      // reserve: header(2) + list-head(1) + detail(~8) + footer(2)
      const detailLines = 2 + 6;
      const footerLines = 3; // status/note line + separator + key legend
      const bodyRows = Math.max(3, h - 2 - detailLines - footerLines);
      renderList(bodyRows);
      // pad list area to a stable height
      const listHead = 1;
      const used = rows.length === 0 ? 2 : Math.min(rows.length, bodyRows - 1);
      for (let i = used + listHead; i < bodyRows; i++) push("");
      renderDetail();
      renderFooter();
    }
    // paint: home, each line cleared to EOL, then clear below.
    let frame = `${ESC}[H`;
    const max = h;
    for (let i = 0; i < Math.min(lines.length, max); i++) {
      frame += lines[i] + `${ESC}[K` + (i < Math.min(lines.length, max) - 1 ? "\r\n" : "");
    }
    frame += `${ESC}[J`;
    out.write(frame);
  }

  // --- data --------------------------------------------------------------
  async function fetchMetrics(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += METRICS_CONCURRENCY) {
      const chunk = ids.slice(i, i + METRICS_CONCURRENCY);
      await Promise.all(
        chunk.map(async (id) => {
          try {
            metrics.set(id, await client.request<LiveMetrics>("GET", `/sandboxes/${id}/metrics`));
          } catch {
            metrics.set(id, metrics.get(id) ?? null);
          }
        }),
      );
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing || stopped || suspended || mode === "confirm") return;
    refreshing = true;
    try {
      const [list, cap] = await Promise.all([
        client.list(),
        client.capacity().catch(() => null),
      ]);
      const oldIndex = selIndex(); // position in the *previous* rows, for clamping
      // running first, then by createdAt (newest first) — a stable, useful order.
      list.sort((a, b) => {
        const pri = (s: string) => (s === "running" ? 0 : s === "paused" ? 1 : 2);
        return pri(a.status) - pri(b.status) || (a.createdAt < b.createdAt ? 1 : -1);
      });
      rows = list;
      capacity = cap as Capacity | null;
      // Keep the same sandbox selected across the re-sort; if it vanished (e.g.
      // destroyed), fall back to whatever now sits at the old row position.
      if (!selectedId || !rows.some((r) => r.id === selectedId)) {
        selectedId = rows.length ? rows[Math.min(oldIndex, rows.length - 1)].id : null;
      }
      // drop metrics for vanished sandboxes
      const ids = new Set(rows.map((r) => r.id));
      for (const k of [...metrics.keys()]) if (!ids.has(k)) metrics.delete(k);
      await fetchMetrics(rows.map((r) => r.id));
      lastError = "";
    } catch (err) {
      lastError = `daemon unreachable: ${formatError(err)}`;
    } finally {
      refreshing = false;
      render();
    }
  }

  // --- actions -----------------------------------------------------------
  async function doAction(verb: string, fn: () => Promise<void>): Promise<void> {
    const r = current();
    if (!r) return;
    status = `${verb} ${shortId(r.id)}…`;
    render();
    try {
      await fn();
      status = `${verb}d ${shortId(r.id)}`;
    } catch (err) {
      lastError = `${verb} failed: ${formatError(err)}`;
      status = "";
    }
    await refresh();
  }

  async function attach(): Promise<void> {
    const r = current();
    if (!r) return;
    // Suspend the TUI (incl. the refresh timer's paints), hand the raw terminal to
    // the PTY bridge, then resume.
    suspended = true;
    detachInput();
    leaveScreen();
    out.write(`${c.dim}attaching to ${r.id} — exit the shell to return to the fleet…${c.reset}\r\n`);
    try {
      await terminalCommand([r.id], globals);
    } catch (err) {
      lastError = `attach failed: ${formatError(err)}`;
    }
    if (stopped) return;
    suspended = false;
    enterScreen();
    attachInput(handleKey);
    await refresh();
  }

  async function createPrompt(): Promise<void> {
    // Drop to cooked mode for a short prompt, then re-enter the TUI.
    suspended = true;
    detachInput();
    leaveScreen();
    const rl = createInterface({ input: stdin, output: out });
    // Ctrl-C: readline swallows SIGINT unless handled; close the interface so
    // the pending ask() REJECTS (below) instead of hanging this prompt forever
    // while the refresh interval keeps the process alive.
    rl.on("SIGINT", () => rl.close());
    const ask = (q: string, def: string) =>
      new Promise<string>((res, rej) => {
        const onClose = () => rej(new Error("cancelled"));
        rl.once("close", onClose);
        rl.question(`${q} ${c.dim}[${def}]${c.reset} `, (a) => {
          rl.off("close", onClose);
          res(a.trim() || def);
        });
      });
    try {
      out.write(`${c.bold}${c.cyan}create sandbox${c.reset} ${c.dim}(blank = default)${c.reset}\r\n`);
      const image = await ask("image", "ghcr.io/sinameraji/hotcell-base:latest");
      const driver = await ask("driver (container|firecracker|applevz)", "container");
      const memRaw = await ask("memory MB", "");
      rl.close();
      const body: Record<string, unknown> = { image, driver };
      const mem = Number(memRaw);
      if (memRaw && Number.isFinite(mem) && mem > 0) body.memoryMb = mem;
      const created = await client.request<SandboxInfo>("POST", "/sandboxes", body);
      status = `created ${shortId(created.id)}`;
    } catch (err) {
      rl.close();
      lastError = `create failed: ${formatError(err)}`;
    }
    if (stopped) return;
    suspended = false;
    enterScreen();
    attachInput(handleKey);
    await refresh();
  }

  function quit(): void {
    stopped = true;
    if (timer) clearInterval(timer);
    restore();
    // The safety-net listener would otherwise accumulate across menu → TUI →
    // menu round-trips (MaxListenersExceededWarning after ~11 visits).
    process.off("exit", restore);
    resolveExit(0);
  }

  // --- input -------------------------------------------------------------
  function handleKey(buf: Buffer): void {
    const s = buf.toString("utf8");

    if (mode === "confirm") {
      if (s === "y" || s === "Y") {
        mode = "list";
        const fn = confirmAction;
        confirmAction = null;
        if (fn) void fn();
      } else if (s === "n" || s === "N" || s === "\x1b" || s === "\r") {
        mode = "list";
        confirmAction = null;
        status = "cancelled";
        render();
      }
      return;
    }

    if (mode === "help") {
      if (s === "?" || s === "\x1b" || s === "q") { mode = "list"; render(); }
      return;
    }

    // list mode
    if (s === "\x03" || s === "q") return quit();
    if (s === "?") { mode = "help"; render(); return; }
    if (s === "\x1b[A" || s === "k") { moveSel(-1); render(); return; }
    if (s === "\x1b[B" || s === "j") { moveSel(1); render(); return; }
    if (s === "\x1b[D" || s === "h") { detailView = (detailView + detailNames.length - 1) % detailNames.length; render(); return; }
    if (s === "\x1b[C" || s === "l") { detailView = (detailView + 1) % detailNames.length; render(); return; }
    if (s === "g") { selectedId = rows[0]?.id ?? null; render(); return; }
    if (s === "G") { selectedId = rows[rows.length - 1]?.id ?? null; render(); return; }
    if (s === "\r" || s === "\n") { void attach(); return; }
    if (s === "c") { void createPrompt(); return; }

    const r = current();
    if (!r) return;
    if (s === "p") {
      void doAction("pause", () => client.request("POST", `/sandboxes/${r.id}/pause`));
    } else if (s === "r") {
      void doAction("resume", () => client.request("POST", `/sandboxes/${r.id}/start`));
    } else if (s === "d") {
      mode = "confirm";
      confirmPrompt = `destroy ${shortId(r.id)} (${r.image})? this deletes its workspace`;
      confirmAction = () => doAction("destroy", () => client.request("DELETE", `/sandboxes/${r.id}`));
      render();
    }
  }

  // --- run loop ----------------------------------------------------------
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((res) => { resolveExit = res; });

  enterScreen();
  render();
  attachInput(handleKey);
  await refresh();
  timer = setInterval(() => { void refresh(); }, REFRESH_MS);

  return exit;
}
