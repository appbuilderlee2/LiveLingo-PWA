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

    private var pipeline: WhisperKit?
    private var recorder: AVAudioRecorder?
    private var loopTask: Task<Void, Never>?
    private var onCaption: ((String) -> Void)?
    private let segmentSeconds: UInt64 = 8

    func prepare() async {
        guard pipeline == nil, !isPreparing else { return }
        isPreparing = true
        status = "正在下載／載入 Whisper tiny 模型…"
        defer { isPreparing = false }
        do {
            // Tiny is the first-step default for responsiveness on iPhone 15 Pro Max.
            pipeline = try await WhisperKit(model: "tiny")
            status = "Whisper 已準備（本地 Core ML）"
        } catch {
            status = "Whisper 模型載入失敗"
            errorMessage = error.localizedDescription
        }
    }

    func start(onCaption: @escaping (String) -> Void) async {
        guard !isListening else { return }
        if pipeline == nil { await prepare() }
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
            onCaption = onCaption
            isListening = true
            status = "Whisper 本地聆聽中"
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
                guard let pipeline else { break }
                status = "Whisper 本地轉錄中"
                let results = try await pipeline.transcribe(audioPath: url.path)
                let text = (results?.text ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    latestText = text
                    onCaption?(text)
                }
                status = "Whisper 本地聆聽中"
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
        status = pipeline == nil ? "Whisper 尚未載入" : "Whisper 已暫停"
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
