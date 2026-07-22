/**
 * Dependency-free check for the interactive prompt primitives. Run:
 * `npm run check:prompts`.
 *
 * Guards the keypress-decoding contract: ONE stdin chunk can carry SEVERAL
 * keypresses (a paste, or type-ahead buffered by the tty line discipline while
 * the CLI does async work and stdin is paused). `readKey` used to resolve with
 * the whole chunk, and `select`/`confirm` compare against exact key literals, so
 * a multi-key chunk matched nothing and every key in it was silently dropped —
 * the prompt ignored you, and a later stray Enter committed the DEFAULT rather
 * than the choice you made.
 *
 * Runs entirely in-process against a fake stdin, so it needs no pty, no
 * terminal, and no daemon.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readKey, select, tokenizeKeys } from "./prompts.js";

const ESC = "\x1b";
let checks = 0;
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};

/** Minimal stand-in for a raw-mode TTY stdin. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(v: boolean): this {
    this.isRaw = v;
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  /** Deliver `s` as a single chunk once a reader has attached. */
  feed(s: string): void {
    const tryEmit = () => {
      if (this.listenerCount("data") > 0) this.emit("data", Buffer.from(s, "utf8"));
      else setImmediate(tryEmit);
    };
    setImmediate(tryEmit);
  }
}

function withFakeStdin<T>(fn: (fake: FakeStdin) => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "stdin")!;
  const fake = new FakeStdin();
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  const restore = () => Object.defineProperty(process, "stdin", real);
  return fn(fake).then(
    (v) => {
      restore();
      return v;
    },
    (e) => {
      restore();
      throw e;
    },
  );
}

/**
 * Fail loudly on a hang. The pre-fix bug's signature is a promise that NEVER
 * settles: the dropped key leaves `readKey` waiting for a chunk that will never
 * arrive, the event loop drains, and node exits 0 — which would make this
 * check silently "pass" against the very regression it exists to catch.
 */
function withTimeout<T>(p: Promise<T>, what: string, ms = 4000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms: ${what} — a keypress was dropped (readKey never resolved)`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Run `fn` with stdout swallowed — select() repaints and would drown the log. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: unknown }).write = () => true;
  try {
    return await fn();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = write;
  }
}

function checkTokenizer(): void {
  const cases: Array<[string, string[], string, string]> = [
    // The regression itself: several keys in one chunk must all survive.
    [`${ESC}[B\r`, [`${ESC}[B`, "\r"], "", "coalesced arrow+Enter splits into two keys"],
    [`${ESC}[B${ESC}[B`, [`${ESC}[B`, `${ESC}[B`], "", "two arrows in one chunk"],
    [`${ESC}[B${ESC}[B\r`, [`${ESC}[B`, `${ESC}[B`, "\r"], "", "type-ahead down,down,enter"],
    ["jj\r", ["j", "j", "\r"], "", "pasted plain characters"],
    [`${ESC}[B\x03`, [`${ESC}[B`, "\x03"], "", "Ctrl-C after an arrow is still seen"],
    // Single keys must be unchanged.
    [`${ESC}[A`, [`${ESC}[A`], "", "single arrow unchanged"],
    ["\r", ["\r"], "", "single Enter unchanged"],
    ["y", ["y"], "", "single character unchanged"],
    [`${ESC}[3~`, [`${ESC}[3~`], "", "tilde-terminated key (Delete)"],
    [`${ESC}OA`, [`${ESC}OA`], "", "SS3 application-mode arrow"],
    ["é", ["é"], "", "multi-byte character stays one key"],
    // A lone ESC must stay an IMMEDIATE cancel, never held as "incomplete",
    // or pressing Escape would hang the prompt.
    [ESC, [ESC], "", "lone ESC is emitted immediately (cancel)"],
    // Genuinely incomplete sequences are held for the next chunk.
    [`${ESC}[`, [], `${ESC}[`, "incomplete CSI is held"],
    [`${ESC}[1;5`, [], `${ESC}[1;5`, "incomplete CSI with params is held"],
    [`${ESC}O`, [], `${ESC}O`, "incomplete SS3 is held"],
  ];
  for (const [input, keys, partial, desc] of cases) {
    const got = tokenizeKeys(input);
    assert.deepEqual(got.keys, keys, `${desc}: keys`);
    assert.equal(got.partial, partial, `${desc}: partial`);
    ok(desc);
  }

  // An escape sequence split across two chunks must reassemble.
  const first = tokenizeKeys(`${ESC}[`);
  const second = tokenizeKeys(first.partial + "B\r");
  assert.deepEqual(second.keys, [`${ESC}[B`, "\r"]);
  ok("escape sequence split across chunks reassembles");
}

async function checkReadKeyBuffers(): Promise<void> {
  await withFakeStdin(async (fake) => {
    fake.feed(`${ESC}[B\r`); // one chunk, two keypresses
    const a = await withTimeout(readKey(), "first readKey");
    const b = await withTimeout(readKey(), "second readKey (buffered key)");
    assert.equal(a, `${ESC}[B`, "first readKey returns the arrow");
    assert.equal(b, "\r", "second readKey returns the buffered Enter");
    ok("readKey hands out buffered keys in order instead of dropping them");
  });

  await withFakeStdin(async (fake) => {
    fake.feed("abc");
    assert.equal(await withTimeout(readKey(), "chunk key 1"), "a");
    assert.equal(await withTimeout(readKey(), "chunk key 2"), "b");
    assert.equal(await withTimeout(readKey(), "chunk key 3"), "c");
    ok("readKey drains a three-character chunk one key at a time");
  });
}

async function checkSelectCommitsIntendedChoice(): Promise<void> {
  // The user-visible failure: the choice the user made must be what commits,
  // not the default that a dropped keystroke used to leave behind.
  const opts = [{ label: "zero" }, { label: "one" }, { label: "two" }];

  const one = await withFakeStdin(async (fake) => {
    fake.feed(`${ESC}[B\r`);
    return withTimeout(quiet(() => select("pick", opts, 0)), "select with coalesced Down+Enter");
  });
  assert.equal(one, 1, "coalesced Down+Enter must commit index 1, not the default 0");
  ok("select commits the intended choice from a coalesced chunk");

  const two = await withFakeStdin(async (fake) => {
    fake.feed(`${ESC}[B${ESC}[B\r`);
    return withTimeout(quiet(() => select("pick", opts, 0)), "select with coalesced Down,Down,Enter");
  });
  assert.equal(two, 2, "coalesced Down,Down,Enter must commit index 2");
  ok("select applies every arrow in a multi-key chunk");

  const def = await withFakeStdin(async (fake) => {
    fake.feed("\r");
    return withTimeout(quiet(() => select("pick", opts, 0)), "select with lone Enter");
  });
  assert.equal(def, 0, "a lone Enter still commits the default");
  ok("lone Enter still commits the default (no behaviour change)");

  const cancelled = await withFakeStdin(async (fake) => {
    fake.feed(ESC);
    return withTimeout(quiet(() => select("pick", opts, 0)), "select with Esc");
  });
  assert.equal(cancelled, -1, "Esc still cancels with -1");
  ok("Esc still cancels immediately");
}

async function main(): Promise<void> {
  checkTokenizer();
  await checkReadKeyBuffers();
  await checkSelectCommitsIntendedChoice();
  console.log(`\nprompts-check: ${checks} checks passed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("prompts-check FAILED:", err);
    process.exit(1);
  },
);
