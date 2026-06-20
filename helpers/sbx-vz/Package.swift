// swift-tools-version:5.9
import PackageDescription

// sbx-vz — the macOS-native helper for the Apple Virtualization microVM driver.
// Node can't call Virtualization.framework directly, so the daemon drives this
// signed binary over a line-delimited JSON-RPC on stdio. M0 implements `probe`
// (is VZ available) and `hostInfo` (memory/cpus); VM lifecycle + vsock brokering
// land in M1+.
let package = Package(
    name: "sbx-vz",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "sbx-vz",
            path: "Sources/sbx-vz",
            linkerSettings: [.linkedFramework("Virtualization")]
        )
    ]
)
