import Foundation
import Virtualization

// sbx-vz: line-delimited JSON-RPC over stdio, driven by the daemon's AppleVzDriver.
//
//   request:  {"id":N,"method":"probe"|"hostInfo"|"shutdown","params":{...}}\n
//   response: {"id":N,"ok":true,"result":{...}}\n  | {"id":N,"ok":false,"error":"..."}\n
//
// M0 surface only. Each response is written with an explicit newline and an
// unbuffered FileHandle write so the Node side reading line-by-line never stalls
// on stdio buffering.

func writeResponse(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))  // '\n'
}

/// Report whether this host + binary can run Virtualization.framework VMs.
func handleProbe() -> [String: Any] {
    var available = false
    var reason = ""
    if #available(macOS 11.0, *) {
        // Constructing a configuration needs no entitlement and proves the
        // framework is linked + usable; actually *starting* a VM (M1) needs the
        // com.apple.security.virtualization entitlement the build signs in.
        _ = VZVirtualMachineConfiguration()
        available = true
    } else {
        reason = "macOS 11.0+ required for Virtualization.framework"
    }
    #if arch(arm64)
    let arch = "arm64"
    #else
    let arch = "x86_64"
    #endif
    return [
        "available": available,
        "reason": reason,
        "arch": arch,
        "macos": ProcessInfo.processInfo.operatingSystemVersionString,
    ]
}

/// Host capacity, mirroring the container driver's Docker MemTotal/NCPU.
func handleHostInfo() -> [String: Any] {
    let memBytes = ProcessInfo.processInfo.physicalMemory
    return [
        "memoryMb": Int(memBytes / (1024 * 1024)),
        "cpus": ProcessInfo.processInfo.activeProcessorCount,
    ]
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
