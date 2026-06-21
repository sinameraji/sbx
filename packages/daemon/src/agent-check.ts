/**
 * Docker-free, VM-free check of the host↔guest agent protocol. Runs the real Go
 * `sbx-agent` over a unix socket (its dev transport) and drives it through the TS
 * `AgentConn` client — validating the wire protocol end-to-end on macOS with no
 * microVM. The same client + protocol then carry every Driver op once the VZ
 * helper relays a guest vsock to a unix socket. Run: `npm run check:agent`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentConn } from "./driver/agent.js";

async function main(): Promise<void> {
  const bin = process.env.SBX_AGENT_BIN ?? "/tmp/sbx-agent-darwin";
  const dir = mkdtempSync(join(tmpdir(), "sbx-agent-"));
  const sock = join(dir, "agent.sock");

  const proc = spawn(bin, [], {
    env: { ...process.env, SBX_AGENT_LISTEN: `unix://${sock}` },
    stdio: ["ignore", "ignore", "inherit"],
  });

  let passed = 0;
  const ok = (label: string) => {
    passed++;
    console.log(`  ✓ ${label}`);
  };

  try {
    for (let i = 0; i < 50 && !existsSync(sock); i++) await sleep(100);
    assert.ok(existsSync(sock), "agent unix socket should appear");

    const conn = await AgentConn.connect({ path: sock });
    assert.equal(conn.hello?.agent, "sbx-agent", "Hello identifies the agent");
    assert.equal(conn.hello?.proto, 1, "proto version");
    ok(`Hello received (version ${conn.hello?.version})`);

    // exec: stdout + stderr + exit code (cwd set since the guest default /workspace
    // doesn't exist on the mac host running this check).
    let out = "";
    let err = "";
    const code = await conn.exec(
      "echo out-line && echo err-line >&2 && exit 3",
      { cwd: dir },
      (e) => {
        if (e.type === "stdout") out += e.data;
        if (e.type === "stderr") err += e.data;
      },
    );
    assert.equal(code, 3, "exec exit code");
    assert.match(out, /out-line/, "exec stdout");
    assert.match(err, /err-line/, "exec stderr");
    ok("exec: stdout/stderr streaming + exit code");

    // writeFile / readFile round-trip.
    await conn.writeFile(join(dir, "f.txt"), "data-123");
    assert.equal(await conn.readFile(join(dir, "f.txt")), "data-123");
    ok("writeFile + readFile round-trip");

    // mkdir + listFiles.
    await conn.mkdir(join(dir, "sub"), true);
    const files = await conn.listFiles(dir);
    assert.ok(files.some((f) => f.name === "f.txt"), "listFiles sees the file");
    assert.ok(files.some((f) => f.name === "sub" && f.isDirectory), "listFiles sees the dir");
    ok("mkdir + listFiles");

    // env overlay: setEnv then read it back via exec.
    await conn.setEnv({ SBX_TEST_VAR: "xyz" });
    let envOut = "";
    await conn.exec("echo $SBX_TEST_VAR", { cwd: dir }, (e) => {
      if (e.type === "stdout") envOut += e.data;
    });
    assert.match(envOut, /xyz/, "setEnv applies to subsequent exec");
    ok("setEnv overlay applies to exec");

    // stats returns (a stub off-Linux, but the RPC round-trips).
    assert.ok(await conn.stats(), "stats RPC returns");
    ok("stats RPC");

    conn.close();
    console.log(`\nagent-check: ${passed} checks passed`);
  } finally {
    proc.kill();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("agent-check FAILED:", err);
    process.exit(1);
  },
);
