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

final class VmServer: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
    private var vm: VZVirtualMachine?
    private var vmConfig: VZVirtualMachineConfiguration?
    private var vsockPort: UInt32 = 1024
    private var egressVsockPort: UInt32 = 0
    private var egressTarget: String = ""
    private var egressListener: VZVirtioSocketListener?
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
        case "snapshot": snapshot(id, params)
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
        if let p = params["egressPort"] as? Int, p > 0 { egressVsockPort = UInt32(p) }
        if let t = params["egressTarget"] as? String { egressTarget = t }
        let cpus = params["cpus"] as? Int ?? 2
        let memMb = UInt64(params["memMb"] as? Int ?? 1024)
        let workspace = params["workspace"] as? String
        let pidsMax = params["pidsMax"] as? Int ?? 0
        let restoreFrom = params["restoreFrom"] as? String

        do {
            let config = VZVirtualMachineConfiguration()
            config.cpuCount = max(1, cpus)
            config.memorySize = memMb * 1024 * 1024

            // Pin the machine identity across helper processes: VZ refuses to
            // restore saved state under a different VZGenericMachineIdentifier,
            // and a fresh config gets a *randomized* one per process — the cause
            // of the bare-EINVAL restore failures. Mint once per sandbox on first
            // boot, persist beside the VM state, reload forever after.
            let platform = VZGenericPlatformConfiguration()
            if let midPath = params["machineIdPath"] as? String {
                if let data = FileManager.default.contents(atPath: midPath),
                   let mid = VZGenericMachineIdentifier(dataRepresentation: data) {
                    platform.machineIdentifier = mid
                } else {
                    try platform.machineIdentifier.dataRepresentation.write(to: URL(fileURLWithPath: midPath))
                }
            }
            config.platform = platform

            let bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
            // Memory + CPU are hard-capped by the VM config above (the guest can't
            // see beyond them). pidsLimit has no VM-config analogue, so it rides in
            // on the kernel cmdline for the guest init to enforce via a cgroup.
            var cmdline = "console=hvc0 root=/dev/vda rw init=/init"
            if pidsMax > 0 { cmdline += " sbx.pids=\(pidsMax)" }
            bootLoader.commandLine = cmdline
            config.bootLoader = bootLoader

            // The rootfs (vda) is READ-ONLY: one image backs every VM of a given
            // OCI image, so a shared read-write mount would corrupt across
            // concurrent sandboxes. The guest init backs writable paths with tmpfs
            // and the per-sandbox workspace (vdb) disk.
            var disks: [VZStorageDeviceConfiguration] = [
                VZVirtioBlockDeviceConfiguration(
                    attachment: try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: rootfs), readOnly: true))
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
            self.vmConfig = config

            // Either restore a saved snapshot (fast resume: RAM + device state come
            // back, no kernel boot) or cold-boot the VM.
            let onRunning: (Result<Void, Error>) -> Void = { result in
                switch result {
                case .success:
                    self.startEgressListener(machine) // guest→host egress relay (both boot + restore)
                    if self.startRelay() {
                        self.ok(id, ["started": true, "restored": restoreFrom != nil])
                    } else {
                        self.fail(id, "vm started but relay socket setup failed")
                    }
                case .failure(let error):
                    self.fail(id, "vm start: \(error.localizedDescription)")
                }
            }
            if let restoreFrom = restoreFrom {
                guard #available(macOS 14.0, *) else {
                    return fail(id, "restore needs macOS 14+")
                }
                machine.restoreMachineStateFrom(url: URL(fileURLWithPath: restoreFrom)) { rerr in
                    if let rerr = rerr {
                        // Surface the full NSError — VZ restore failures are often a
                        // bare "invalid argument" whose domain/code/reason are the
                        // only clues (e.g. VZErrorDomain#12 = config/state mismatch).
                        let ns = rerr as NSError
                        let reason = ns.localizedFailureReason ?? ""
                        return self.fail(id, "restore: \(rerr.localizedDescription) [\(ns.domain)#\(ns.code)] \(reason)")
                    }
                    machine.resume(completionHandler: onRunning)
                }
            } else {
                machine.start(completionHandler: onRunning)
            }
        } catch {
            fail(id, "start setup: \(error.localizedDescription)")
        }
    }

    /// Pause the running VM and save its full state (RAM + devices) to `path`, so
    /// a later `start {restoreFrom: path}` resumes instantly without a kernel boot.
    /// Requires macOS 14+. The caller tears the helper down afterward; the saved
    /// state + the workspace disk are all that's needed to resume.
    private func snapshot(_ id: Any?, _ params: [String: Any]) {
        guard let path = params["path"] as? String else { return fail(id, "snapshot: path required") }
        guard let vm = self.vm else { return fail(id, "snapshot: no running vm") }
        guard #available(macOS 14.0, *) else { return fail(id, "snapshot needs macOS 14+") }
        // Preflight: name the offending device up front instead of a bare EINVAL
        // at save time if a config change ever breaks save/restore support.
        if let cfg = self.vmConfig {
            do { try cfg.validateSaveRestoreSupport() } catch {
                return fail(id, "saveRestoreSupport: \(error.localizedDescription)")
            }
        }
        vm.pause { presult in
            switch presult {
            case .failure(let e):
                self.fail(id, "pause: \(e.localizedDescription)")
            case .success:
                vm.saveMachineStateTo(url: URL(fileURLWithPath: path)) { serr in
                    if let serr = serr {
                        self.fail(id, "saveMachineState: \(serr.localizedDescription)")
                    } else {
                        self.ok(id, ["snapshot": path])
                    }
                }
            }
        }
    }

    // MARK: guest→host egress relay (vsock listener → TCP to the gateway)

    /// Install a vsock listener for guest-initiated connections on the egress
    /// port, splicing each one to a fresh TCP connection to the egress gateway.
    /// This is the NIC-less guest's only route out of the VM: default-deny holds
    /// by construction — there is no network device to escape through.
    private func startEgressListener(_ machine: VZVirtualMachine) {
        guard egressVsockPort > 0, !egressTarget.isEmpty else { return }
        guard let dev = machine.socketDevices.first as? VZVirtioSocketDevice else {
            note("egress: no vsock device; relay disabled")
            return
        }
        let listener = VZVirtioSocketListener()
        listener.delegate = self
        dev.setSocketListener(listener, forPort: egressVsockPort)
        egressListener = listener
        note("egress relay: vsock :\(egressVsockPort) → \(egressTarget)")
    }

    func listener(
        _ listener: VZVirtioSocketListener,
        shouldAcceptNewConnection connection: VZVirtioSocketConnection,
        from socketDevice: VZVirtioSocketDevice
    ) -> Bool {
        guard let fd = dialTCP(egressTarget) else {
            note("egress relay: cannot reach \(egressTarget)")
            return false
        }
        let relay = Relay(clientFD: fd, conn: connection)
        let key = ObjectIdentifier(relay)
        relay.onClose = { [weak self] in self?.relays[key] = nil }
        relays[key] = relay
        relay.start()
        return true
    }

    /// Blocking TCP connect to "host:port" (loopback-fast; the gateway is local).
    private func dialTCP(_ target: String) -> Int32? {
        let parts = target.split(separator: ":")
        guard parts.count == 2, let port = UInt16(parts[1]) else { return nil }
        var host = String(parts[0])
        if host == "localhost" { host = "127.0.0.1" }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        if inet_pton(AF_INET, host, &addr.sin_addr) != 1 {
            close(fd)
            return nil
        }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if rc != 0 {
            close(fd)
            return nil
        }
        return fd
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
