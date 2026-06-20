import Foundation
import Virtualization

// Boot bring-up harness (M1). `sbx-vz boot-test <kernel> <rootfs> [consoleLog]`
// boots a microVM directly (no daemon), writes the guest console to a log, and —
// once up — tries to connect to the agent's vsock port. Success on stdout as JSON.
// This isolates the kernel/rootfs/VZ-config bring-up from the full driver lifecycle;
// once it reaches the agent, the same configuration moves into the driver path.
final class BootTest: NSObject, VZVirtualMachineDelegate {
    private let vm: VZVirtualMachine
    private let vsockPort: UInt32

    init(kernel: String, rootfs: String, consoleLog: String, cpus: Int, memMb: UInt64, vsockPort: UInt32) throws {
        self.vsockPort = vsockPort

        let config = VZVirtualMachineConfiguration()
        config.cpuCount = cpus
        config.memorySize = memMb * 1024 * 1024

        let bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
        // console=hvc0 → virtio-console; root=/dev/vda → the rootfs block device;
        // init=/init → our mount-then-exec-agent shim.
        bootLoader.commandLine = "console=hvc0 root=/dev/vda rw init=/init"
        config.bootLoader = bootLoader

        let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: rootfs), readOnly: false)
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]

        FileManager.default.createFile(atPath: consoleLog, contents: nil)
        guard let writeHandle = FileHandle(forWritingAtPath: consoleLog) else {
            throw NSError(domain: "sbx-vz", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot open console log"])
        }
        let console = VZVirtioConsoleDeviceSerialPortConfiguration()
        console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: writeHandle)
        config.serialPorts = [console]

        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]

        try config.validate()
        self.vm = VZVirtualMachine(configuration: config)
        super.init()
        self.vm.delegate = self
    }

    private func emit(_ obj: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: obj) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        }
    }

    private func note(_ s: String) {
        FileHandle.standardError.write(("[sbx-vz] " + s + "\n").data(using: .utf8)!)
    }

    func run() {
        vm.start { result in
            switch result {
            case .success:
                self.note("vm started; waiting for guest + agent")
            case .failure(let error):
                self.emit(["ok": false, "error": "vm start failed: \(error.localizedDescription)"])
                exit(2)
            }
        }

        // Give the guest time to boot, mount, and have the agent bind vsock:1024,
        // then probe the agent by connecting. Retry a few times before giving up.
        attemptConnect(retriesLeft: 12, delay: 1.5)
        RunLoop.main.run()
    }

    private func attemptConnect(retriesLeft: Int, delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard let dev = self.vm.socketDevices.first as? VZVirtioSocketDevice else {
                self.emit(["ok": false, "error": "no vsock device on VM"])
                exit(3)
            }
            dev.connect(toPort: self.vsockPort) { result in
                switch result {
                case .success(let conn):
                    self.note("agent vsock connect ok (fd \(conn.fileDescriptor))")
                    self.emit(["ok": true, "result": ["vsockConnected": true, "port": self.vsockPort]])
                    exit(0)
                case .failure(let error):
                    if retriesLeft > 0 {
                        self.note("vsock not ready (\(error.localizedDescription)); \(retriesLeft) retries left")
                        self.attemptConnect(retriesLeft: retriesLeft - 1, delay: 1.0)
                    } else {
                        self.emit(["ok": false, "error": "agent vsock never came up: \(error.localizedDescription)"])
                        exit(4)
                    }
                }
            }
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        note("guest stopped")
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        note("guest stopped with error: \(error.localizedDescription)")
    }
}
