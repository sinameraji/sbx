/**
 * In-sandbox code-interpreter kernels.
 *
 * Each code context runs one of these as a long-lived background process. A
 * kernel keeps a persistent namespace (so variables/imports survive across
 * `runCode` calls, Jupyter-style) and serves one cell at a time over a pair of
 * named pipes in its context directory:
 *
 *   - reads a sequence number from `in.fifo`
 *   - executes `cell-<seq>.code`
 *   - writes a JSON `cell-<seq>.result.json` ({ stdout, stderr, results, error })
 *   - signals completion by writing a line to `out.fifo`
 *
 * The daemon coordinates a single round-trip per call (see runCode in the API),
 * so cells on one context are serialized.
 */

export type KernelLanguage = "python" | "javascript";

export function kernelFor(language: KernelLanguage): {
  filename: string;
  source: string;
  command: (dir: string) => string;
} {
  if (language === "python") {
    return {
      filename: "kernel.py",
      source: PYTHON_KERNEL,
      command: (dir) => `python3 -u ${dir}/kernel.py`,
    };
  }
  return {
    filename: "kernel.js",
    source: JS_KERNEL,
    command: (dir) => `node ${dir}/kernel.js`,
  };
}

const PYTHON_KERNEL = String.raw`
import sys, os, json, ast, io, traceback, contextlib

CTX_DIR = os.path.dirname(os.path.abspath(__file__))
IN = os.path.join(CTX_DIR, "in.fifo")
OUT = os.path.join(CTX_DIR, "out.fifo")

# Persistent namespace shared across cells.
ns = {"__name__": "__main__"}

def run_cell(code):
    stdout, stderr = io.StringIO(), io.StringIO()
    results = []
    error = None
    try:
        tree = ast.parse(code)
        last = tree.body[-1] if tree.body else None
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if isinstance(last, ast.Expr):
                # Run everything but the trailing expression, then eval it so its
                # value becomes a result (mirrors a notebook cell).
                head = ast.Module(body=tree.body[:-1], type_ignores=[])
                exec(compile(head, "<cell>", "exec"), ns)
                value = eval(compile(ast.Expression(last.value), "<cell>", "eval"), ns)
                if value is not None:
                    results.append({"type": "text", "text": repr(value)})
            else:
                exec(compile(tree, "<cell>", "exec"), ns)
    except Exception:
        error = traceback.format_exc()
    return {"stdout": stdout.getvalue(), "stderr": stderr.getvalue(),
            "results": results, "error": error}

while True:
    with open(IN) as f:
        seq = f.read().strip()
    if not seq:
        continue
    try:
        with open(os.path.join(CTX_DIR, "cell-%s.code" % seq)) as cf:
            code = cf.read()
        result = run_cell(code)
    except Exception:
        result = {"stdout": "", "stderr": "", "results": [],
                  "error": traceback.format_exc()}
    with open(os.path.join(CTX_DIR, "cell-%s.result.json" % seq), "w") as rf:
        json.dump(result, rf)
    with open(OUT, "w") as of:
        of.write("done\n")
`;

const JS_KERNEL = String.raw`
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const util = require("util");

const CTX_DIR = __dirname;
const IN = path.join(CTX_DIR, "in.fifo");
const OUT = path.join(CTX_DIR, "out.fifo");

// Persistent context shared across cells (var/global assignments survive).
const sandbox = { require, process, Buffer, setTimeout, clearTimeout };
sandbox.global = sandbox;
const context = vm.createContext(sandbox);

function fmt(v) {
  return typeof v === "string" ? v : util.inspect(v, { depth: 4 });
}

function runCell(code) {
  let stdout = "", stderr = "";
  const results = [];
  let error = null;
  sandbox.console = {
    log: (...a) => { stdout += a.map(fmt).join(" ") + "\n"; },
    info: (...a) => { stdout += a.map(fmt).join(" ") + "\n"; },
    error: (...a) => { stderr += a.map(fmt).join(" ") + "\n"; },
    warn: (...a) => { stderr += a.map(fmt).join(" ") + "\n"; },
  };
  try {
    const value = vm.runInContext(code, context, { filename: "<cell>" });
    if (value !== undefined) results.push({ type: "text", text: fmt(value) });
  } catch (e) {
    error = (e && e.stack) ? String(e.stack) : String(e);
  }
  return { stdout, stderr, results, error };
}

for (;;) {
  const seq = fs.readFileSync(IN, "utf8").trim();
  if (!seq) continue;
  let result;
  try {
    const code = fs.readFileSync(path.join(CTX_DIR, "cell-" + seq + ".code"), "utf8");
    result = runCell(code);
  } catch (e) {
    result = { stdout: "", stderr: "", results: [],
               error: (e && e.stack) ? String(e.stack) : String(e) };
  }
  fs.writeFileSync(path.join(CTX_DIR, "cell-" + seq + ".result.json"), JSON.stringify(result));
  fs.writeFileSync(OUT, "done\n");
}
`;
