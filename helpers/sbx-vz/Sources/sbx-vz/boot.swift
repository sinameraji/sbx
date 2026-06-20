import Foundation
import Virtualization

// Boot bring-up harness (M1). `sbx-vz boot-test <kernel> <rootfs> [consoleLog]`
// boots a microVM directly (no daemon), streams the guest console to the log AND
// our stderr (live), and — once up — tries to connect to the agent's vsock port.
// Success on stdout as JSON. Isolates kernel/rootfs/VZ-config bring-up from the
// full driver lifecycle.
final class BootTest: NSObject, VZVirtualMachineDelegate {
    private let vm: VZVirtualMachine
    private let vsockPort: UInt32
    private let consoleLogPath: String
    private var consolePipe: Pipe?

    init(kernel: String, rootfs: String, consoleLog: String, cpus: Int, memMb: UInt64, vsockPort: UInt32) throws {
        self.vsockPort = vsockPort
        self.consoleLogPath = consoleLog

        let config = VZVirtualMachineConfiguration()
        config.cpuCount = cpus
        config.memorySize = memMb * 1024 * 1024

        let bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
        bootLoader.commandLine = "console=hvc0 root=/dev/vda rw init=/init"
        config.bootLoader = bootLoader

        let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: rootfs), readOnly: false)
        config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]

        // Console over a Pipe (a regular-file fd is silently dropped by VZ's serial
        // attachment) — drained live in `run()` to the log file + stderr.
        let pipe = Pipe()
        let console = VZVirtioConsoleDeviceSerialPortConfiguration()
        console.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: nil,
            fileHandleForWriting: pipe.fileHandleForWriting
        )
        config.serialPorts = [console]

        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]

        try config.validate()
        self.vm = VZVirtualMachine(configuration: config)
        super.init()
        self.consolePipe = pipe
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
        // Drain the guest console pipe → log file + our stderr (live visibility).
        FileManager.default.createFile(atPath: consoleLogPath, contents: nil)
        let logFH = FileHandle(forWritingAtPath: consoleLogPath)
        consolePipe?.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { return }
            logFH?.write(data)
            FileHandle.standardError.write(data)
        }

        vm.start { result in
            switch result {
            case .success:
                self.note("vm started; waiting for guest + agent")
            case .failure(let error):
                self.emit(["ok": false, "error": "vm start failed: \(error.localizedDescription)"])
                exit(2)
            }
        }
        attemptConnect(retriesLeft: 15, delay: 1.5)
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
                        self.note("vsock not ready (\(error.localizedDescription)); \(retriesLeft) left")
                        self.attemptConnect(retriesLeft: retriesLeft - 1, delay: 1.0)
                    } else {
                        self.emit(["ok": false, "error": "agent vsock never came up: \(error.localizedDescription)"])
                        exit(4)
                    }
                }
            }
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) { note("guest stopped") }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        note("guest stopped with error: \(error.localizedDescription)")
    }
}
