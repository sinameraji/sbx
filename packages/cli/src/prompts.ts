import { createInterface } from "node:readline";

/**
 * Hand-rolled interactive primitives for the setup/create wizards and the home
 * menu — select, confirm, text — on the same raw-mode stdin pattern as the TUI
 * and the hidden key prompt. Zero dependencies on purpose (the CLI is installed
 * by agents; no Ink/React). Every prompt is TTY-only by contract: callers gate
 * on `process.stdin.isTTY` before ever reaching these.
 */

const ESC = "\x1b";
export const c = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[38;5;244m`,
  green: `${ESC}[38;5;114m`,
  cyan: `${ESC}[38;5;80m`,
  yellow: `${ESC}[38;5;179m`,
  red: `${ESC}[38;5;203m`,
};

/** Read one raw key chunk (arrow keys arrive as a single escape sequence). */
export function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* not a tty */
    }
    stdin.resume();
    const onData = (b: Buffer) => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode?.(wasRaw ?? false);
      } catch {
        /* ignore */
      }
      stdin.pause();
      const s = b.toString("utf8");
      if (s === "\x03") {
        // Ctrl-C: restore the terminal, then exit like a signal would.
        process.stdout.write("\n");
        process.exit(130);
      }
      resolve(s);
    };
    stdin.on("data", onData);
  });
}

export interface SelectOption {
  label: string;
  /** Dimmed annotation after the label. */
  hint?: string;
}

/**
 * Clamp a rendered line to the terminal width. The repaint arithmetic counts
 * logical lines, but `ESC[nA` moves by physical rows — a wrapped line would
 * corrupt every repaint, so no line may ever wrap.
 */
function clampLine(plain: string, styled: string): string {
  const width = (process.stdout.columns || 80) - 1;
  if (plain.length <= width) return styled;
  // Rebuild from the plain text, truncated — styling is lost on the overflow
  // line, which beats a corrupted frame.
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

export interface SelectBehavior {
  /** Lead the frame with a blank spacer row, erased along with the menu. */
  pad?: boolean;
  /**
   * On pick or Esc, erase the whole menu instead of collapsing to a `label
   * chosen` line — for menu loops that repaint on every return, so revisiting
   * the menu doesn't stack a residue row per visit.
   */
  erase?: boolean;
}

/**
 * Arrow-key radio select. Renders inline (no alt-screen), repaints in place, and
 * collapses to a single `label  chosen` line once picked (or vanishes entirely
 * with `erase`). Returns the chosen index, or **-1 on Esc** — callers map that
 * to back/cancel/default.
 */
export async function select(
  label: string,
  options: SelectOption[],
  def = 0,
  behavior: SelectBehavior = {},
): Promise<number> {
  const out = process.stdout;
  let idx = def;
  let painted = 0;

  const line = (text: string, styled: string) => clampLine(text, styled) + `${ESC}[K\n`;
  const paint = () => {
    if (painted) out.write(`${ESC}[${painted}A`); // cursor back to first line
    let frame = behavior.pad ? `${ESC}[K\n` : "";
    frame += line(`  ${visible(label)}`, `  ${c.bold}${label}${c.reset}`);
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      const sel = i === idx;
      const marker = sel ? `${c.cyan}▸${c.reset}` : " ";
      const text = sel ? `${c.bold}${o.label}${c.reset}` : o.label;
      const plain = `   ${sel ? "▸" : " "} ${o.label}${o.hint ? `  ${o.hint}` : ""}`;
      frame += line(plain, `   ${marker} ${text}${o.hint ? `  ${c.dim}${o.hint}${c.reset}` : ""}`);
    }
    out.write(frame);
    painted = options.length + 1 + (behavior.pad ? 1 : 0);
  };

  paint();
  for (;;) {
    const k = await readKey();
    if (k === `${ESC}[A` || k === "k") idx = (idx + options.length - 1) % options.length;
    else if (k === `${ESC}[B` || k === "j") idx = (idx + 1) % options.length;
    else if (k.length === 1 && k >= "1" && k <= String(Math.min(9, options.length))) idx = Number(k) - 1;
    else if (k === "\r" || k === "\n") break;
    else if (k === ESC) {
      // Esc = back/cancel: erase the menu and let the caller decide.
      out.write(`${ESC}[${painted}A${ESC}[J`);
      if (!behavior.erase) out.write(`  ${c.dim}${label}  (cancelled)${c.reset}\n`);
      return -1;
    }
    paint();
  }
  out.write(`${ESC}[${painted}A${ESC}[J`);
  // Collapse the menu to one confirmation line (unless it should vanish).
  if (!behavior.erase) out.write(`  ${c.dim}${label}${c.reset}  ${c.green}${options[idx].label}${c.reset}\n`);
  return idx;
}

/** Visible text of a possibly-styled label (for width math). */
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** y/n confirm on a single key. Enter = the default. */
export async function confirm(label: string, def = true): Promise<boolean> {
  const hint = def ? "Y/n" : "y/N";
  process.stdout.write(`  ${c.bold}${label}${c.reset} ${c.dim}[${hint}]${c.reset} `);
  for (;;) {
    const k = await readKey();
    if (k === "\r" || k === "\n") {
      process.stdout.write(`${def ? "yes" : "no"}\n`);
      return def;
    }
    if (k === "y" || k === "Y") {
      process.stdout.write("yes\n");
      return true;
    }
    if (k === "n" || k === "N" || k === ESC) {
      process.stdout.write("no\n");
      return false;
    }
  }
}

/** Cooked-mode text input with a dimmed default (blank = default). */
export function textInput(label: string, def = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    // Without this, readline swallows Ctrl-C: the promise never settles and the
    // process drains to exit 0 — a silent "success". Match readKey's 130.
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      process.exit(130);
    });
    const suffix = def ? ` ${c.dim}[${def}]${c.reset}` : ` ${c.dim}(blank = none)${c.reset}`;
    rl.question(`  ${c.bold}${label}${c.reset}${suffix} `, (answer) => {
      rl.close();
      resolve(answer.trim() || def);
    });
  });
}
