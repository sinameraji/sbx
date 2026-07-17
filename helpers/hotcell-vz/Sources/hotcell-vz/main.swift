import Foundation

// hotcell-vz entrypoint. Modes:
//   hotcell-vz                    one-shot stdio JSON-RPC (probe / hostInfo) — M0.
//   hotcell-vz serve              persistent VM lifecycle + vsock relay — M1+.
//   hotcell-vz boot-test K R [L]  direct boot bring-up harness.

let cliArgs = CommandLine.arguments

// Persistent lifecycle server (M1+): `hotcell-vz serve` — the daemon drives VM
// start/stop + the vsock relay over stdio. Never returns.
if cliArgs.count >= 2 && cliArgs[1] == "serve" {
    VmServer().run()
}

// Boot bring-up mode (M1): `hotcell-vz boot-test <kernel> <rootfs> [consoleLog]`.
if cliArgs.count >= 4 && cliArgs[1] == "boot-test" {
    let consoleLog = cliArgs.count >= 5 ? cliArgs[4] : "/tmp/hotcell-vz-console.log"
    do {
        let test = try BootTest(
            kernel: cliArgs[2], rootfs: cliArgs[3], consoleLog: consoleLog,
            cpus: 1, memMb: 512, vsockPort: 1024
        )
        test.run()  // runs the main RunLoop; exits via its result handlers
    } catch {
        FileHandle.standardError.write("boot-test setup failed: \(error)\n".data(using: .utf8)!)
        exit(5)
    }
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        writeResponse(["ok": false, "error": "bad json"])
        continue
    }
    let method = (req["method"] as? String) ?? ""
    var resp: [String: Any] = [:]
    if let id = req["id"] { resp["id"] = id }
    switch method {
    case "probe":
        resp["ok"] = true
        resp["result"] = handleProbe()
    case "hostInfo":
        resp["ok"] = true
        resp["result"] = handleHostInfo()
    case "shutdown":
        exit(0)
    default:
        resp["ok"] = false
        resp["error"] = "unknown method: \(method)"
    }
    writeResponse(resp)
}
