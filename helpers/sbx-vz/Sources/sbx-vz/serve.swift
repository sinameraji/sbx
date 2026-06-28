import Foundation
import Virtualization

// Persistent lifecycle server (`sbx-vz serve`). The daemon spawns one per sandbox
// and drives it over a line-delimited JSON-RPC on stdio:
//   {"id":N,"method":"start","params":{kernel,rootfs,workspace?,cpus,memMb,socketPath,vsockPort?}}
//   {"id":N,"method":"stop"} / {"method":"shutdown"} / probe / hostInfo
// On `start` it boots the microVM and listens on `socketPath` (unix). Each
// connection to that socket is bridged to a fresh vsock connection to the guest
// agent (port 1024 by default), so the daemon's AgentConn — which connects to the
// unix socket — speaks the wire protocol straight to the in-guest agent.
//
// VZ requires VM ops on its queue (main here); stdin is read on a background
// thread and each request is hopped to the main queue so the RunLoop stays free
// for VZ + the relay's dispatch sources.

/// Bidirectional byte relay between an accepted unix-socket client and one guest
/// vsock connection, built on `DispatchSource` reads with non-blocking fds so an
/// `EAGAIN` (no data yet) is never mistaken for EOF. Retains the
/// VZVirtioSocketConnection so its fd stays valid for the relay's lifetime.
final class Relay {
    private let clientFD: Int32
    private let vsockFD: Int32
    private let conn: VZVirtioSocketConnection
    private var srcClient: DispatchSourceRead?
    private var srcVsock: DispatchSourceRead?
    private let queue = DispatchQueue(label: "sbx-vz.relay")
    var onClose: (() -> Void)?
    private var closed = false

    init(clientFD: Int32, conn: VZVirtioSocketConnection) {
        self.conn = conn
        self.clientFD = clientFD
        self.vsockFD = dup(conn.fileDescriptor)
        setNonBlocking(clientFD)
        setNonBlocking(vsockFD)
    }

    func start() {
        srcClient = pump(from: clientFD, to: vsockFD)
        srcVsock = pump(from: vsockFD, to: clientFD)
    }

    private func pump(from src: Int32, to dst: Int32) -> DispatchSourceRead {
        let source = DispatchSource.makeReadSource(fileDescriptor: src, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self = self, !self.closed else { return }
            var buf = [UInt8](repeating: 0, count: 65536)
            let n = read(src, &buf, buf.count)
            if n > 0 {
                var off = 0
                while off < n {
                    let w = buf.withUnsafeBytes { raw in
                        write(dst, raw.baseAddress!.advanced(by: off), n - off)
                    }
                    if w > 0 { off += w }
                    else if w < 0 && (errno == EAGAIN || errno == EINTR) { continue }
                    else { self.close(); return }
                }
            } else if n == 0 {
                self.close() // EOF
            } else if errno != EAGAIN && errno != EINTR {
                self.close()
            }
        }
        source.setCancelHandler { Darwin.close(src) }
        source.resume()
        return source
    }

    func close() {
        if closed { return }
        closed = true
        srcClient?.cancel() // cancel handlers close clientFD + vsockFD
        srcVsock?.cancel()
        onClose?()
        onClose = nil
    }
}

private func setNonBlocking(_ fd: Int32) {
    let flags = fcntl(fd, F_GETFL, 0)
    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
}

final class VmServer: NSObject, VZVirtualMachineDelegate {
    private var vm: VZVirtualMachine?
    private var vsockPort: UInt32 = 1024
    private var socketPath: String = ""
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var consolePipe: Pipe?
    private var relays: [ObjectIdentifier: Relay] = [:]
    private let replyLock = NSLock()

    func run() {
        let reader = Thread { self.readLoop() }
        reader.stackSize = 1 << 20
        reader.start()
        RunLoop.main.run()
    }

    // MARK: stdio JSON-RPC

    private func readLoop() {
        while let line = readLine(strippingNewline: true) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                reply(["ok": false, "error": "bad json"])
                continue
            }
            DispatchQueue.main.async { self.handle(req) }
        }
        DispatchQueue.main.async { self.teardown(); exit(0) }
    }

    private func reply(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        replyLock.lock()
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
        replyLock.unlock()
    }

    private func note(_ s: String) {
        FileHandle.standardError.write(("[sbx-vz] " + s + "\n").data(using: .utf8)!)
    }

    private func ok(_ id: Any?, _ result: [String: Any]) {
        var r: [String: Any] = ["ok": true, "result": result]
        if let id = id { r["id"] = id }
        reply(r)
    }
    private func fail(_ id: Any?, _ msg: String) {
        var r: [String: Any] = ["ok": false, "error": msg]
        if let id = id { r["id"] = id }
        reply(r)
    }

    private func handle(_ req: [String: Any]) {
        let id = req["id"]
        let method = req["method"] as? String ?? ""
        let params = req["params"] as? [String: Any] ?? [:]
        switch method {
        case "probe": ok(id, handleProbe())
        case "hostInfo": ok(id, handleHostInfo())
        case "start": startVM(id, params)
        case "stop": teardown(); ok(id, ["stopped": true])
        case "shutdown": teardown(); exit(0)
        default: fail(id, "unknown method: \(method)")
        }
    }

    // MARK: VM lifecycle

    private func startVM(_ id: Any?, _ params: [String: Any]) {
        guard let kernel = params["kernel"] as? String,
              let rootfs = params["rootfs"] as? String,
              let socketPath = params["socketPath"] as? String else {
            return fail(id, "start: kernel, rootfs, socketPath required")
        }
        self.socketPath = socketPath
        if let p = params["vsockPort"] as? Int { vsockPort = UInt32(p) }
        let cpus = params["cpus"] as? Int ?? 2
        let memMb = UInt64(params["memMb"] as? Int ?? 1024)
        let workspace = params["workspace"] as? String
        let pidsMax = params["pidsMax"] as? Int ?? 0

        do {
            let config = VZVirtualMachineConfiguration()
            config.cpuCount = max(1, cpus)
            config.memorySize = memMb * 1024 * 1024

            let bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
            // Memory + CPU are hard-capped by the VM config above (the guest can't
            // see beyond them). pidsLimit has no VM-config analogue, so it rides in
            // on the kernel cmdline for the guest init to enforce via a cgroup.
            var cmdline = "console=hvc0 root=/dev/vda rw init=/init"
            if pidsMax > 0 { cmdline += " sbx.pids=\(pidsMax)" }
            bootLoader.commandLine = cmdline
            config.bootLoader = bootLoader

            var disks: [VZStorageDeviceConfiguration] = [
                VZVirtioBlockDeviceConfiguration(
                    attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: rootfs), readOnly: false))
            ]
            if let workspace = workspace {
                disks.append(VZVirtioBlockDeviceConfiguration(
                    attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: workspace), readOnly: false)))
            }
            config.storageDevices = disks

            let pipe = Pipe()
            let console = VZVirtioConsoleDeviceSerialPortConfiguration()
            console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: pipe.fileHandleForWriting)
            config.serialPorts = [console]
            consolePipe = pipe
            pipe.fileHandleForReading.readabilityHandler = { h in
                let d = h.availableData
                if !d.isEmpty { FileHandle.standardError.write(d) }
            }

            config.socketDevices = [VZVirtioSocketDeviceConfiguration()]

            try config.validate()
            let machine = VZVirtualMachine(configuration: config)
            machine.delegate = self
            self.vm = machine

            machine.start { result in
                switch result {
                case .success:
                    if self.startRelay() {
                        self.ok(id, ["started": true])
                    } else {
                        self.fail(id, "vm started but relay socket setup failed")
                    }
                case .failure(let error):
                    self.fail(id, "vm start: \(error.localizedDescription)")
                }
            }
        } catch {
            fail(id, "start setup: \(error.localizedDescription)")
        }
    }

    private func teardown() {
        acceptSource?.cancel()
        acceptSource = nil
        if listenFD >= 0 { close(listenFD); listenFD = -1 }
        if !socketPath.isEmpty { unlink(socketPath) }
        for r in relays.values { r.close() }
        relays.removeAll()
        if let vm = vm, vm.canRequestStop {
            try? vm.requestStop()
        }
        vm = nil
    }

    // MARK: unix-socket → vsock relay

    private func startRelay() -> Bool {
        unlink(socketPath)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { note("socket() failed: \(errno)"); return false }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        if pathBytes.count > MemoryLayout.size(ofValue: addr.sun_path) {
            note("socket path too long"); close(fd); return false
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { dst in
            dst.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dstChars in
                pathBytes.withUnsafeBufferPointer { src in
                    _ = strncpy(dstChars, src.baseAddress!, pathBytes.count)
                }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, len) }
        }
        if bound != 0 { note("bind() failed: \(errno)"); close(fd); return false }
        if listen(fd, 16) != 0 { note("listen() failed: \(errno)"); close(fd); return false }

        listenFD = fd
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        src.setEventHandler { [weak self] in self?.acceptOne() }
        src.resume()
        acceptSource = src
        note("relay listening on \(socketPath)")
        return true
    }

    private func acceptOne() {
        let clientFD = accept(listenFD, nil, nil)
        if clientFD < 0 { return }
        guard let dev = vm?.socketDevices.first as? VZVirtioSocketDevice else {
            close(clientFD); return
        }
        dev.connect(toPort: vsockPort) { result in
            switch result {
            case .success(let conn):
                let relay = Relay(clientFD: clientFD, conn: conn)
                let key = ObjectIdentifier(relay)
                relay.onClose = { [weak self] in self?.relays[key] = nil }
                self.relays[key] = relay
                relay.start()
            case .failure(let error):
                self.note("vsock connect failed: \(error.localizedDescription)")
                close(clientFD)
            }
        }
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) { note("guest stopped") }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        note("guest stopped with error: \(error.localizedDescription)")
    }
}
