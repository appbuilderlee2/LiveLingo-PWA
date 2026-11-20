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
    func update(_ id: UUID, original: String) {
        guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
        entries[index] = CaptionEntry(id: id, timestamp: entries[index].timestamp, original: original, translated: "翻譯中…")
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
    private var onPartialCallback: ((String) -> Void)?
    private var committedPrefix = ""

    func start(onPartial: @escaping (String) -> Void, onFinal: @escaping (String) -> Void) async {
        guard !isListening else { return }
        onFinalCallback = onFinal
        onPartialCallback = onPartial
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
            committedPrefix = ""
            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let result {
                        let text = result.bestTranscription.formattedString
                        let remaining = text.hasPrefix(self.committedPrefix) ? String(text.dropFirst(self.committedPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines) : text
                        self.liveText = remaining
                        if !result.isFinal && !remaining.isEmpty { self.onPartialCallback?(remaining) }
                        if !result.isFinal && remaining.split(separator: " ").count >= 16 {
                            self.committedPrefix = text
                            self.onFinalCallback?(remaining)
                            self.liveText = ""
                        }
                        if result.isFinal && text != self.lastFinal {
                            self.lastFinal = text
                            if !remaining.isEmpty { onFinal(remaining) }
                            self.committedPrefix = ""
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
        onPartialCallback = nil
        committedPrefix = ""
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}

struct ContentView: View {
    @StateObject private var store = CaptionStore()
    @StateObject private var speech = LocalSpeech()
    @StateObject private var nativeWhisper = NativeWhisper()
    @State private var useWhisper = false
    @State private var selectedWhisperModel = "tiny"
    @State private var translationConfig: TranslationSession.Configuration? =
        .init(source: Locale.Language(identifier: "en"), target: Locale.Language(identifier: "zh-Hant"))
    @State private var translationQueue: [UUID] = []
    @State private var showSettings = false
    @State private var liveCaptionID: UUID?
    @State private var translationRevision = 0
    @State private var liveTranslationTask: Task<Void, Never>?

    private func enqueueTranslation(_ id: UUID) {
        if !translationQueue.contains(id) { translationQueue.append(id) }
        translationRevision += 1
        translationConfig = .init(source: Locale.Language(identifier: "en"), target: Locale.Language(identifier: "zh-Hant"))
    }

    private func receivePartial(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if let id = liveCaptionID {
            // Update ONLY the active segment; finalized entries remain untouched below.
            store.update(id, original: clean)
        } else {
            store.add(clean)
            liveCaptionID = store.entries.first?.id
        }
        guard let id = liveCaptionID else { return }
        liveTranslationTask?.cancel()
        liveTranslationTask = Task {
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled else { return }
            enqueueTranslation(id)
        }
    }

    private func appendCaption(_ text: String) {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        liveTranslationTask?.cancel()
        guard !clean.isEmpty else { return }
        if let id = liveCaptionID {
            // Freeze this entry: future partials will create a NEW entry at index 0.
            store.update(id, original: clean)
            liveCaptionID = nil
            enqueueTranslation(id)
        } else {
            store.add(clean)
            if let id = store.entries.first?.id { enqueueTranslation(id) }
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
                Text("字幕紀錄 · 新段落在上，舊段落保留在下").font(.headline)
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
                    if speech.isListening { speech.stop(); liveCaptionID = nil }
                    else { Task { await speech.start(onPartial: receivePartial, onFinal: appendCaption) } }
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
                        Toggle("使用 Whisper 本地辨識", isOn: $useWhisper)
                            .onChange(of: useWhisper) { _, _ in
                                nativeWhisper.stop()
                                speech.stop()
                            }
                        Picker("目前使用模型", selection: $selectedWhisperModel) {
                            Text("tiny（快，預設）").tag("tiny")
                            Text("base（較準確）").tag("base")
                        }
                        .onChange(of: selectedWhisperModel) { _, model in
                            nativeWhisper.stop()
                            nativeWhisper.selectModel(model)
                        }
                        ForEach(["tiny", "base"], id: \.self) { model in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text("Whisper \(model)")
                                        .font(.body.weight(.medium))
                                    Text(nativeWhisper.isDownloaded(model) ? "已載入，可離線使用" : "可預先下載")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button {
                                    Task { await nativeWhisper.prepare(model: model) }
                                } label: {
                                    if nativeWhisper.preparingModel == model {
                                        ProgressView()
                                    } else {
                                        Label(nativeWhisper.isDownloaded(model) ? "已準備" : "下載", systemImage: nativeWhisper.isDownloaded(model) ? "checkmark.circle.fill" : "arrow.down.circle")
                                    }
                                }
                                .disabled(nativeWhisper.isPreparing || nativeWhisper.isDownloaded(model))
                            }
                        }
                        Text(nativeWhisper.status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("可先下載 tiny 及 base，再選擇運行其中一個；Whisper 模型首次下載需要網絡。")
                        Text("預設為 Apple Speech 本地即時辨識：講話時持續顯示未完成嘅英文字幕。Whisper 分段模式較慢，適合準確度優先。")
                        Text("翻譯：Apple Translation（首次可能需要下載語言套件）")
                        Text("Whisper 透過 WhisperKit / Apple Core ML 執行；目前以約 2 秒音訊分段轉錄，仍須等待辨識運算。兩種模式暫未同時運行。")
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
