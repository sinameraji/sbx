import Foundation
import Virtualization

// Shared one-shot RPC helpers used by both the stdio loop (M0 ping/hostInfo) and
// the persistent `serve` server.

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
