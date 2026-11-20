import Foundation
import AVFoundation
import Speech

/// iOS 26+ streaming recognizer. Interim text is never written to permanent history.
@available(iOS 26.0, *)
@MainActor
final class StreamingSpeech: ObservableObject {
    @Published var isListening = false
    @Published var liveText = ""
    @Published var errorMessage: String?
    private let engine = AVAudioEngine()
    private var analyzer: SpeechAnalyzer?
    private var builder: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?
    private var onFinal: ((String) -> Void)?
    private var onPartial: ((String) -> Void)?
    private var converter: AVAudioConverter?
    private var targetFormat: AVAudioFormat?

    func start(onPartial: @escaping (String) -> Void, onFinal: @escaping (String) -> Void) async {
        guard !isListening else { return }
        let mic = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard mic else { errorMessage = "請允許咪高峰權限"; return }
        do {
            let requested = Locale(identifier: "en-AU")
            guard let locale = SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
                errorMessage = "SpeechTranscriber 暫時不支援英文語言模型"
                return
            }
            let transcriber = SpeechTranscriber(locale: locale,
                                                 transcriptionOptions: [],
                                                 reportingOptions: [.volatileResults],
                                                 attributeOptions: [])
            if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                try await install.downloadAndInstall()
            }
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
            self.targetFormat = format
            let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
            builder = continuation
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            self.analyzer = analyzer
            self.onFinal = onFinal
            self.onPartial = onPartial
            resultsTask = Task { [weak self] in
                do {
                    for try await result in transcriber.results {
                        guard let self else { break }
                        let value = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !value.isEmpty else { continue }
                        if result.isFinal {
                            self.liveText = ""
                            self.onFinal?(value)
                        } else {
                            self.liveText = value
                            self.onPartial?(value)
                        }
                    }
                } catch {
                    self?.errorMessage = error.localizedDescription
                }
            }
            try await analyzer.start(inputSequence: stream)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true)
            let input = engine.inputNode
            let inputFormat = input.outputFormat(forBus: 0)
            guard let audioConverter = AVAudioConverter(from: inputFormat, to: format) else {
                throw NSError(domain: "LiveLingo", code: 2, userInfo: [NSLocalizedDescriptionKey: "無法建立音訊格式轉換器"])
            }
            self.converter = audioConverter
            input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
                // Conversion is serialized onto the model actor; recording continues across pauses.
                Task { @MainActor [weak self] in
                    guard let self, self.isListening, let converter = self.converter else { return }
                    do {
                        guard let targetFormat = self.targetFormat else { return }
                        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
                        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 128)
                        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
                        var supplied = false
                        var conversionError: NSError?
                        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
                            if supplied {
                                inputStatus.pointee = .noDataNow
                                return nil
                            }
                            supplied = true
                            inputStatus.pointee = .haveData
                            return buffer
                        }
                        if let conversionError { throw conversionError }
                        if status != .error && output.frameLength > 0 {
                            self.builder?.yield(AnalyzerInput(buffer: output))
                        }
                    } catch {
                        self.errorMessage = error.localizedDescription
                    }
                }
            }
            engine.prepare()
            isListening = true
            try engine.start()
        } catch {
            errorMessage = error.localizedDescription
            stop()
        }
    }

    func stop() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        builder?.finish()
        builder = nil
        resultsTask?.cancel()
        resultsTask = nil
        if let analyzer {
            Task { await analyzer.cancelAndFinishNow() }
        }
        analyzer = nil
        converter = nil
        targetFormat = nil
        isListening = false
        liveText = ""
        onFinal = nil
        onPartial = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
