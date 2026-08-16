import AVFoundation
import Capacitor
import Darwin

private struct NativeClick {
    let id: UInt64
    let atTimeSec: Double
    let kind: String
    var scheduled: Bool
}

private final class NativeAudioController: @unchecked Sendable {
    static let shared = NativeAudioController()

    private let queue = DispatchQueue(label: "work.bonifacio.feelmyrythm.native-audio", qos: .userInteractive)
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var buffers: [String: AVAudioPCMBuffer] = [:]
    private var clicks: [NativeClick] = []
    private var timer: DispatchSourceTimer?
    private var nextID: UInt64 = 1
    private var volume: Float = 0.8
    private var interrupted = false
    private var naturalEndTimeSec: Double?
    private var interruptionObserver: NSObjectProtocol?
    private var stopListener: ((String) -> Void)?

    private init() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: nil
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }
    }

    deinit {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
    }

    func start(volume: Double, completion: @escaping (Result<(Double, Double), Error>) -> Void) {
        queue.async {
            do {
                self.volume = Float(volume)
                try self.prepareEngine()
                let session = AVAudioSession.sharedInstance()
                let now = AVAudioTime.seconds(forHostTime: mach_absolute_time())
                completion(.success((now, session.outputLatency + session.ioBufferDuration)))
            } catch {
                completion(.failure(error))
            }
        }
    }

    func setStopListener(_ listener: @escaping (String) -> Void) {
        queue.async { self.stopListener = listener }
    }

    func schedule(_ incoming: [(Double, String)], completion: @escaping () -> Void) {
        queue.async {
            for (atTimeSec, kind) in incoming {
                self.clicks.append(
                    NativeClick(id: self.nextID, atTimeSec: atTimeSec, kind: kind, scheduled: false)
                )
                self.nextID &+= 1
            }
            self.clicks.sort { left, right in
                left.atTimeSec == right.atTimeSec ? left.id < right.id : left.atTimeSec < right.atTimeSec
            }
            self.naturalEndTimeSec = self.clicks.last?.atTimeSec
            self.pump()
            completion()
        }
    }

    func cancelScheduled(from cutoff: Double, completion: @escaping () -> Void) {
        queue.async {
            self.clicks.removeAll { $0.atTimeSec + 0.000_001 >= cutoff }
            self.naturalEndTimeSec = self.clicks.last?.atTimeSec
            self.rebuildPlayerSchedule()
            completion()
        }
    }

    func setVolume(_ value: Double, completion: @escaping () -> Void) {
        queue.async {
            self.volume = Float(value)
            self.player?.volume = self.volume
            completion()
        }
    }

    func stop(completion: @escaping () -> Void) {
        queue.async {
            self.clicks.removeAll()
            self.naturalEndTimeSec = nil
            self.timer?.cancel()
            self.timer = nil
            self.player?.stop()
            self.engine?.stop()
            self.player = nil
            self.engine = nil
            self.buffers.removeAll()
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: [.notifyOthersOnDeactivation]
            )
            completion()
        }
    }

    private func prepareEngine() throws {
        if let engine, let player {
            player.volume = volume
            if !engine.isRunning && !interrupted {
                try AVAudioSession.sharedInstance().setActive(true)
                try engine.start()
                player.play()
                rebuildPlayerSchedule()
            }
            ensureTimer()
            return
        }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.005)
        try session.setActive(true)

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let sampleRate = session.sampleRate > 0 ? session.sampleRate : 48_000
        guard let format = AVAudioFormat(
            standardFormatWithSampleRate: sampleRate,
            channels: 2
        ) else {
            throw NSError(
                domain: "NativeAudio",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Could not create the native audio format"]
            )
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        buffers = Self.makeBuffers(format: format)
        player.volume = volume
        engine.prepare()
        try engine.start()
        player.play()
        self.engine = engine
        self.player = player
        ensureTimer()
    }

    private func ensureTimer() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(40), leeway: .milliseconds(4))
        timer.setEventHandler { [weak self] in self?.pump() }
        timer.resume()
        self.timer = timer
    }

    private func pump() {
        guard !interrupted, let player, player.isPlaying else { return }
        let now = AVAudioTime.seconds(forHostTime: mach_absolute_time())
        clicks.removeAll { click in click.scheduled && click.atTimeSec < now - 0.12 }
        if clicks.isEmpty, let naturalEndTimeSec, now > naturalEndTimeSec + 0.2 {
            player.stop()
            engine?.pause()
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: [.notifyOthersOnDeactivation]
            )
            timer?.cancel()
            timer = nil
            self.naturalEndTimeSec = nil
            let stopListener = self.stopListener
            DispatchQueue.main.async { stopListener?("naturalEnd") }
            return
        }
        let horizon = now + 0.75
        for index in clicks.indices where !clicks[index].scheduled {
            guard clicks[index].atTimeSec <= horizon else { break }
            let click = clicks[index]
            guard click.atTimeSec >= now - 0.02, let buffer = buffers[click.kind] else {
                clicks[index].scheduled = true
                continue
            }
            let hostTime = AVAudioTime.hostTime(forSeconds: click.atTimeSec)
            player.scheduleBuffer(buffer, at: AVAudioTime(hostTime: hostTime), options: [])
            clicks[index].scheduled = true
        }
    }

    private func rebuildPlayerSchedule() {
        guard let player else { return }
        player.stop()
        let now = AVAudioTime.seconds(forHostTime: mach_absolute_time())
        clicks.removeAll { $0.atTimeSec < now - 0.02 }
        for index in clicks.indices { clicks[index].scheduled = false }
        if !interrupted {
            player.play()
            pump()
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
        queue.async {
            if type == .began {
                self.interrupted = true
                self.player?.pause()
                self.engine?.pause()
                return
            }
            self.interrupted = false
            do {
                try AVAudioSession.sharedInstance().setActive(true)
                if let engine = self.engine, !engine.isRunning { try engine.start() }
                self.rebuildPlayerSchedule()
            } catch {
                NSLog("FeelMyRythm native audio resume failed: %@", error.localizedDescription)
            }
        }
    }

    private static func makeBuffers(format: AVAudioFormat) -> [String: AVAudioPCMBuffer] {
        let definitions: [String: (Double, Double, Double, Double)] = [
            "downbeat": (1_760, 2.1, 0.055, 0.95),
            "beat": (1_180, 2.4, 0.045, 0.72),
            "sub": (760, 1.7, 0.028, 0.46),
            "countIn": (2_240, 1.45, 0.060, 0.82)
        ]
        var result: [String: AVAudioPCMBuffer] = [:]
        for (kind, definition) in definitions {
            let length = AVAudioFrameCount(max(1, ceil(definition.2 * format.sampleRate)))
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: length),
                  let channels = buffer.floatChannelData else { continue }
            buffer.frameLength = length
            for frame in 0..<Int(length) {
                let time = Double(frame) / format.sampleRate
                let attack = min(1, time / 0.0008)
                let envelope = attack * exp(-time * (kind == "sub" ? 115 : 78))
                let primary = sin(2 * Double.pi * definition.0 * time)
                let overtone = sin(2 * Double.pi * definition.0 * definition.1 * time + 0.35)
                let noiseSeed = sin(Double(frame + 1) * 12.9898) * 43_758.5453
                let transient = ((noiseSeed - floor(noiseSeed)) * 2 - 1) * exp(-time * 260)
                let sample = Float(
                    definition.3 * envelope * (0.68 * primary + 0.24 * overtone + 0.08 * transient)
                )
                for channel in 0..<Int(format.channelCount) { channels[channel][frame] = sample }
            }
            result[kind] = buffer
        }
        return result
    }
}

@objc(NativeAudioPlugin)
public final class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlugin"
    public let jsName = "NativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleClicks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelScheduledFrom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    @objc override public func load() {
        NativeAudioController.shared.setStopListener { [weak self] reason in
            self?.notifyListeners(
                "stopped",
                data: ["reason": reason],
                retainUntilConsumed: true
            )
        }
    }

    @objc public func start(_ call: CAPPluginCall) {
        guard let volume = boundedVolume(call) else { return }
        NativeAudioController.shared.start(volume: volume) { result in
            switch result {
            case .success(let (nativeTimeSec, outputLatencySec)):
                call.resolve([
                    "nativeTimeSec": nativeTimeSec,
                    "outputLatencySec": outputLatencySec
                ])
            case .failure(let error):
                call.reject("Native audio could not start", nil, error)
            }
        }
    }

    @objc public func scheduleClicks(_ call: CAPPluginCall) {
        guard let rawClicks = call.getArray("clicks", JSObject.self) else {
            call.reject("clicks is required")
            return
        }
        var clicks: [(Double, String)] = []
        let validKinds = Set(["downbeat", "beat", "sub", "countIn"])
        for raw in rawClicks {
            guard let atTimeSec = raw["atTimeSec"] as? Double,
                  atTimeSec.isFinite,
                  let kind = raw["kind"] as? String,
                  validKinds.contains(kind) else {
                call.reject("Every click requires a finite atTimeSec and valid kind")
                return
            }
            clicks.append((atTimeSec, kind))
        }
        NativeAudioController.shared.schedule(clicks) { call.resolve() }
    }

    @objc public func cancelScheduledFrom(_ call: CAPPluginCall) {
        guard let atTimeSec = call.getDouble("atTimeSec"), atTimeSec.isFinite else {
            call.reject("atTimeSec must be finite")
            return
        }
        NativeAudioController.shared.cancelScheduled(from: atTimeSec) { call.resolve() }
    }

    @objc public func setVolume(_ call: CAPPluginCall) {
        guard let volume = boundedVolume(call) else { return }
        NativeAudioController.shared.setVolume(volume) { call.resolve() }
    }

    @objc public func stop(_ call: CAPPluginCall) {
        NativeAudioController.shared.stop { call.resolve() }
    }

    private func boundedVolume(_ call: CAPPluginCall) -> Double? {
        guard let volume = call.getDouble("volume"), volume.isFinite, volume >= 0, volume <= 1 else {
            call.reject("volume must be between 0 and 1")
            return nil
        }
        return volume
    }
}
