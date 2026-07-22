import { c } from "./prompts.js";

/**
 * Live multi-row progress renderer for long-running parallel work (create).
 * Hand-rolled on the same in-place repaint idiom as prompts.ts (`ESC[nA` +
 * per-line `ESC[K`), zero dependencies. Renders to stderr so stdout stays
 * machine-clean; on a non-TTY stream every method is a no-op, preserving the
 * silent-until-done contract for agents/CI/pipes.
 */

const ESC = "\x1b";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 100;

export interface ProgressHandle {
  /** Replace the status text of a pending row (e.g. "creating (cloning repo)"). */
  update(index: number, text: string): void;
  /** Freeze a row as ✓/✗ with its final text; elapsed is captured at this moment. */
  settle(index: number, ok: boolean, text: string): void;
  /** Final repaint (no spinner glyphs), restore the cursor, detach handlers. */
  stop(): void;
}

interface Row {
  label: string;
  text: string;
  state: "pending" | "ok" | "fail";
  startedAt: number;
  elapsedMs?: number;
}

export function startProgress(
  labels: string[],
  stream: NodeJS.WriteStream = process.stderr,
): ProgressHandle {
  if (!stream.isTTY) {
    return { update: () => {}, settle: () => {}, stop: () => {} };
  }

  const startedAt = Date.now();
  const rows: Row[] = labels.map((label) => ({
    label,
    text: "creating",
    state: "pending",
    startedAt,
  }));
  // `ESC[nA` can't move above the top of the screen, so when the rows won't fit
  // collapse to a single aggregate line and just count settlements.
  const aggregate = rows.length + 1 > (stream.rows || 24);
  const lineCount = aggregate ? 1 : rows.length;
  let frame = 0;
  let painted = false;
  let active = true;

  const clamp = (plain: string, styled: string): string => {
    const width = (stream.columns || 80) - 1;
    if (plain.length <= width) return styled;
    return plain.slice(0, Math.max(0, width - 1)) + "…";
  };

  const fmtElapsed = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  };

  const rowLine = (row: Row, spin: string): string => {
    const glyph =
      row.state === "ok" ? "✓" : row.state === "fail" ? "✗" : spin;
    const color = row.state === "ok" ? c.green : row.state === "fail" ? c.red : c.cyan;
    const elapsed = fmtElapsed(row.elapsedMs ?? Date.now() - row.startedAt);
    const label = row.label ? `${row.label}  ` : "";
    const plain = `  ${glyph} ${label}${row.text}  ${elapsed}`;
    const styled = `  ${color}${glyph}${c.reset} ${label}${row.text}  ${c.dim}${elapsed}${c.reset}`;
    return clamp(plain, styled);
  };

  const aggregateLine = (spin: string): string => {
    const done = rows.filter((r) => r.state !== "pending").length;
    const failed = rows.filter((r) => r.state === "fail").length;
    const all = done === rows.length;
    const glyph = all ? (failed ? "✗" : "✓") : spin;
    const color = all ? (failed ? c.red : c.green) : c.cyan;
    const plain =
      `  ${glyph} creating ${rows.length} sandboxes…  ${done}/${rows.length} done` +
      `${failed ? ` (${failed} failed)` : ""}  ${fmtElapsed(Date.now() - startedAt)}`;
    const styled = plain.replace(glyph, `${color}${glyph}${c.reset}`);
    return clamp(plain, styled);
  };

  const paint = (final = false): void => {
    const spin = final ? "…" : FRAMES[frame % FRAMES.length];
    let out = painted ? `${ESC}[${lineCount}A` : `${ESC}[?25l`;
    if (aggregate) {
      out += aggregateLine(spin) + `${ESC}[K\n`;
    } else {
      for (const row of rows) out += rowLine(row, spin) + `${ESC}[K\n`;
    }
    stream.write(out);
    painted = true;
  };

  const showCursor = (): void => {
    stream.write(`${ESC}[?25h`);
  };
  const onExit = (): void => showCursor();
  const onSigint = (): void => {
    showCursor();
    stream.write(
      `\n  ${c.dim}interrupted — sandboxes keep provisioning on the daemon; check hotcell ls${c.reset}\n`,
    );
    process.exit(130);
  };
  process.on("exit", onExit);
  process.on("SIGINT", onSigint);

  paint();
  const timer = setInterval(() => {
    frame++;
    paint();
  }, TICK_MS);

  return {
    update(index, text) {
      const row = rows[index];
      if (active && row && row.state === "pending") row.text = text;
    },
    settle(index, ok, text) {
      const row = rows[index];
      if (!active || !row || row.state !== "pending") return;
      row.state = ok ? "ok" : "fail";
      row.text = text;
      row.elapsedMs = Date.now() - row.startedAt;
    },
    stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
      paint(true);
      showCursor();
      process.off("exit", onExit);
      process.off("SIGINT", onSigint);
    },
  };
}
