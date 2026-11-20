import Foundation
import AVFoundation
import WhisperKit

/// Native Core ML Whisper. Audio stays on the phone; model download requires network.
@MainActor
final class NativeWhisper: ObservableObject {
    @Published var isPreparing = false
    @Published var isListening = false
    @Published var status = "Whisper 尚未載入"
    @Published var errorMessage: String?
    @Published var latestText = ""
    @Published private(set) var downloadedModels: Set<String> = []
    @Published private(set) var activeModel = "tiny"
    @Published private(set) var preparingModel: String?
    private var modelCache: [String: WhisperKit] = [:]
    private let supportedModels: Set<String> = ["tiny", "base"]

    private var pipeline: WhisperKit?
    private var recorder: AVAudioRecorder?
    private var loopTask: Task<Void, Never>?
    private var onCaption: ((String) -> Void)?
    private let segmentSeconds: UInt64 = 2

    func isDownloaded(_ model: String) -> Bool {
        downloadedModels.contains(model)
    }

    func prepare(model: String = "tiny") async {
        guard supportedModels.contains(model), !isPreparing else { return }
        if modelCache[model] != nil {
            downloadedModels.insert(model)
            status = "Whisper \(model) 已準備"
            return
        }
        isPreparing = true
        preparingModel = model
        status = "正在下載／載入 Whisper \(model)…"
        defer {
            isPreparing = false
            preparingModel = nil
        }
        do {
            let loaded = try await WhisperKit(model: model)
            modelCache[model] = loaded
            downloadedModels.insert(model)
            status = "Whisper \(model) 已準備（本地 Core ML）"
        } catch {
            status = "Whisper \(model) 模型載入失敗"
            errorMessage = error.localizedDescription
        }
    }

    func selectModel(_ model: String) {
        guard supportedModels.contains(model), !isListening else { return }
        activeModel = model
        pipeline = modelCache[model]
        status = pipeline == nil ? "Whisper \(model) 尚未載入" : "Whisper \(model) 已準備"
    }

    func start(onCaption: @escaping (String) -> Void) async {
        guard !isListening else { return }
        if pipeline == nil { await prepare(model: activeModel) }
        pipeline = modelCache[activeModel]
        guard pipeline != nil else { return }
        let allowed = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard allowed else {
            errorMessage = "請到 iPhone 設定允許 LiveLingo 使用咪高峰。"
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement)
            try session.setActive(true)
            self.onCaption = onCaption
            isListening = true
            status = "Whisper \(activeModel) 本地聆聽中"
            loopTask = Task { [weak self] in
                guard let self else { return }
                await self.recordLoop()
            }
        } catch {
            errorMessage = error.localizedDescription
            stop()
        }
    }

    private func recordLoop() async {
        while isListening && !Task.isCancelled {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
            do {
                let settings: [String: Any] = [
                    AVFormatIDKey: Int(kAudioFormatLinearPCM),
                    AVSampleRateKey: 16000.0,
                    AVNumberOfChannelsKey: 1,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false
                ]
                let current = try AVAudioRecorder(url: url, settings: settings)
                recorder = current
                guard current.record() else { throw NSError(domain: "LiveLingo", code: 1, userInfo: [NSLocalizedDescriptionKey: "咪高峰錄音啟動失敗"]) }
                try await Task.sleep(for: .seconds(segmentSeconds))
                current.stop()
                recorder = nil
                guard isListening, let pipeline else { break }
                status = "Whisper \(activeModel) 本地轉錄中"
                let results = try await pipeline.transcribe(audioPath: url.path)
                let text = results.map(\.text).joined(separator: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    latestText = text
                    onCaption?(text)
                }
                status = "Whisper \(activeModel) 本地聆聽中"
            } catch is CancellationError {
                recorder?.stop()
                recorder = nil
            } catch {
                errorMessage = error.localizedDescription
                status = "Whisper 運算失敗"
                isListening = false
            }
            try? FileManager.default.removeItem(at: url)
        }
        recorder?.stop()
        recorder = nil
    }

    func stop() {
        isListening = false
        loopTask?.cancel()
        loopTask = nil
        recorder?.stop()
        recorder = nil
        onCaption = nil
        status = pipeline == nil ? "Whisper \(activeModel) 尚未載入" : "Whisper \(activeModel) 已暫停"
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
