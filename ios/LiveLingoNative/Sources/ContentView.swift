import SwiftUI
import Speech
import AVFoundation
import Translation

struct CaptionEntry: Identifiable, Codable {
    var id = UUID()
    let timestamp: Date
    let original: String
    var translated: String
}

@MainActor
final class CaptionStore: ObservableObject {
    @Published var entries: [CaptionEntry] = [] {
        didSet { save() }
    }
    init() {
        guard let data = UserDefaults.standard.data(forKey: "native-captions"),
              let saved = try? JSONDecoder().decode([CaptionEntry].self, from: data) else { return }
        entries = saved
    }
    func add(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        entries.insert(CaptionEntry(timestamp: .now, original: clean, translated: "翻譯中…"), at: 0)
    }
    func translate(_ translated: String, for id: UUID) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[index].translated = translated
    }
    private func save() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        UserDefaults.standard.set(data, forKey: "native-captions")
    }
}

@MainActor
final class LocalSpeech: ObservableObject {
    @Published var isListening = false
    @Published var liveText = ""
    @Published var errorMessage: String?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-AU"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var lastFinal = ""
    private var onFinalCallback: ((String) -> Void)?

    func start(onFinal: @escaping (String) -> Void) async {
        guard !isListening else { return }
        onFinalCallback = onFinal
        let speechAuthorized = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
        let micAuthorized = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard speechAuthorized && micAuthorized else {
            errorMessage = "請到 iPhone 設定允許咪高峰及語音辨識。"
            return
        }
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            errorMessage = "此語言暫時無法使用 iPhone 本地語音辨識。"
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.requiresOnDeviceRecognition = true
            req.shouldReportPartialResults = true
            request = req
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                req.append(buffer)
            }
            engine.prepare()
            try engine.start()
            isListening = true
            lastFinal = ""
            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result {
                        let text = result.bestTranscription.formattedString
                        self.liveText = text
                        if result.isFinal && text != self.lastFinal {
                            self.lastFinal = text
                            onFinal(text)
                            self.liveText = ""
                        }
                    }
                    if let error { self.errorMessage = error.localizedDescription; self.stop() }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
            stop()
        }
    }

    func stop() {
        if !liveText.isEmpty && liveText != lastFinal {
            lastFinal = liveText
            onFinalCallback?(liveText)
        }
        liveText = ""
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        isListening = false
        onFinalCallback = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}

struct ContentView: View {
    @StateObject private var store = CaptionStore()
    @StateObject private var speech = LocalSpeech()
    @StateObject private var nativeWhisper = NativeWhisper()
    @State private var useWhisper = false
    @State private var translationConfig: TranslationSession.Configuration? =
        .init(source: Locale.Language(identifier: "en"), target: Locale.Language(identifier: "zh-Hant"))
    @State private var translationQueue: [UUID] = []
    @State private var showSettings = false

    private func appendCaption(_ text: String) {
        store.add(text)
        if let id = store.entries.first?.id {
            translationQueue.append(id)
            translationConfig?.invalidate()
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("LiveLingo").font(.title2.bold())
                Spacer()
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape").font(.title3)
                }
                .accessibilityLabel("設定")
            }
            .padding(.horizontal, 18).padding(.top, 10).padding(.bottom, 8)

            VStack(alignment: .leading, spacing: 10) {
                Label(useWhisper ? nativeWhisper.status : (speech.isListening ? "即時逐字辨識中" : "已暫停"), systemImage: (useWhisper ? nativeWhisper.isListening : speech.isListening) ? "waveform" : "pause.circle")
                    .font(.caption).foregroundStyle(.secondary)
                Text("原文 · English").font(.caption2).foregroundStyle(.secondary)
                Text(useWhisper ? (store.entries.first?.original ?? "撳咪高峰開始字幕") : (speech.liveText.isEmpty ? (store.entries.first?.original ?? "撳咪高峰開始字幕") : speech.liveText))
                    .font(.system(size: 29, weight: .semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Divider()
                Text("翻譯 · 繁體中文").font(.caption2).foregroundStyle(.secondary)
                Text(store.entries.first?.translated ?? "翻譯將顯示喺度")
                    .font(.system(size: 22, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
            .padding(.horizontal, 14)

            HStack {
                Text("字幕紀錄").font(.headline)
                Spacer()
                Text("最新優先").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 5)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(store.entries) { entry in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(entry.timestamp, style: .time).font(.caption2).foregroundStyle(.secondary)
                            Text(entry.original).font(.body.weight(.medium))
                            Text(entry.translated).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 11)
                        Divider().opacity(0.5)
                    }
                }.padding(.horizontal, 18)
            }
            Button {
                if useWhisper {
                    if nativeWhisper.isListening { nativeWhisper.stop() }
                    else { Task { await nativeWhisper.start(onCaption: appendCaption) } }
                } else {
                    if speech.isListening { speech.stop() }
                    else { Task { await speech.start(onFinal: appendCaption) } }
                }
            } label: {
                Label((useWhisper ? nativeWhisper.isListening : speech.isListening) ? "暫停" : "開始聆聽", systemImage: (useWhisper ? nativeWhisper.isListening : speech.isListening) ? "pause.fill" : "mic.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity).padding(12)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 1, green: 0.36, blue: 0.33))
            .padding(.horizontal, 18).padding(.bottom, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .foregroundStyle(.white)
        .background(Color(red: 0.03, green: 0.075, blue: 0.13).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .translationTask(translationConfig) { session in
            while !translationQueue.isEmpty {
                let id = translationQueue.removeFirst()
                guard let entry = store.entries.first(where: { $0.id == id }) else { continue }
                do {
                    let response = try await session.translate(entry.original)
                    store.translate(response.targetText, for: id)
                } catch {
                    store.translate("翻譯未完成：請檢查系統語言套件", for: id)
                }
            }
        }
        .alert("Whisper", isPresented: Binding(get: { nativeWhisper.errorMessage != nil }, set: { if !$0 { nativeWhisper.errorMessage = nil } })) {
            Button("知道") { nativeWhisper.errorMessage = nil }
        } message: { Text(nativeWhisper.errorMessage ?? "") }
        .alert("語音辨識", isPresented: Binding(get: { speech.errorMessage != nil }, set: { if !$0 { speech.errorMessage = nil } })) {
            Button("知道") { speech.errorMessage = nil }
        } message: { Text(speech.errorMessage ?? "") }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                Form {
                    Section("辨識及翻譯") {
                        Toggle("Whisper 高準確度模式（約 8 秒分段）", isOn: $useWhisper)
                            .onChange(of: useWhisper) { _, _ in
                                nativeWhisper.stop()
                                speech.stop()
                            }
                        Button {
                            Task { await nativeWhisper.prepare() }
                        } label: {
                            Label(nativeWhisper.isPreparing ? "正在下載 Whisper…" : "下載／載入 Whisper 模型", systemImage: "arrow.down.circle")
                        }
                        .disabled(nativeWhisper.isPreparing)
                        if nativeWhisper.isPreparing { ProgressView("正在準備本地模型…") }
                        Text(nativeWhisper.status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Whisper tiny 首次使用需要網絡下載模型；之後本機運算。")
                        Text("預設為 Apple Speech 本地即時辨識：講話時持續顯示未完成嘅英文字幕。Whisper 分段模式較慢，適合準確度優先。")
                        Text("翻譯：Apple Translation（首次可能需要下載語言套件）")
                        Text("Whisper 透過 WhisperKit / Apple Core ML 執行；目前以約 8 秒音訊分段轉錄。兩種模式暫未同時運行。")
                    }
                    Section("本機紀錄") {
                        Text("字幕只保存在本機。")
                        Button("清除字幕紀錄", role: .destructive) { store.entries.removeAll() }
                    }
                }
                .navigationTitle("設定")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("完成") { showSettings = false } } }
            }
        }
    }
}
