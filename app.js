import { lessonStore } from './storage.js';

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const APP_VERSION = '2.5.2';
const whisper = window.LiveLingoWhisper;
const WHISPER_MODELS = whisper?.models || {
  'tiny-en-q5_1': { name: 'tiny.en Q5_1', sizeMb: 31 },
  'base-en-q5_1': { name: 'base.en Q5_1', sizeMb: 57 },
  'small-en-q5_1': { name: 'small.en Q5_1', sizeMb: 181 }
};
const RECOGNITION_MODES = {
  realtime: { label: '即時', needsWhisper: false },
  smart: { label: '智能校正', needsWhisper: true },
  offline: { label: '離線辨識', needsWhisper: true }
};
const LANGUAGE_DIRECTIONS = {
  'en-zh': { speechLang: 'en-AU', source: 'en', target: 'zh-TW', label: '英文 → 繁體中文' },
  'zh-en': { speechLang: 'zh-HK', source: 'zh-TW', target: 'en', label: '中文 → 英文' }
};

const el = (id) => document.getElementById(id);
const elements = {
  app: el('app'), micButton: el('micButton'), micLabel: el('micLabel'), liveStatus: el('liveStatus'),
  statusLabel: el('statusLabel'), elapsedTime: el('elapsedTime'), finishButton: el('finishButton'),
  chineseSubtitle: el('chineseSubtitle'), englishSubtitle: el('englishSubtitle'), interimText: el('interimText'),
  subtitleStage: el('subtitleStage'), transcriptList: el('transcriptList'), transcriptEmpty: el('transcriptEmpty'),
  largeModeButton: el('largeModeButton'), copyButton: el('copyButton'), exportButton: el('exportButton'), historyDialog: el('historyDialog'),
  settingsDialog: el('settingsDialog'), lessonDialog: el('lessonDialog'), historyList: el('historyList'), toast: el('toast'),
  whisperModelCard: el('whisperModelCard'), whisperStatus: el('whisperStatus'), whisperProgress: el('whisperProgress'),
  whisperProgressBar: el('whisperProgressBar'), whisperCompatibility: el('whisperCompatibility'),
  whisperProgressText: el('whisperProgressText'),
  whisperModelName: el('whisperModelName'), whisperModelDetail: el('whisperModelDetail'),
  downloadWhisperButton: el('downloadWhisperButton'), deleteWhisperButton: el('deleteWhisperButton'), activeModeBadge: el('activeModeBadge'),
  translationDirectionLabel: el('translationDirectionLabel'), languageDirectionNote: el('languageDirectionNote'), largeModeLabel: el('largeModeLabel'),
  captionStateBadge: el('captionStateBadge'), captionStateText: el('captionStateText'),
  previousCaptionBlock: el('previousCaptionBlock'), previousChineseSubtitle: el('previousChineseSubtitle'),
  previousEnglishSubtitle: el('previousEnglishSubtitle')
};

const state = {
  recognition: null,
  isListening: false,
  isPaused: false,
  shouldRestart: false,
  startTime: null,
  accumulatedMs: 0,
  timer: null,
  segments: [],
  currentLessonId: null,
  pendingExport: null,
  interimTimer: null,
  interimToken: 0,
  lastInterim: '',
  lastInterimTranslatedText: '',
  lastInterimRequestAt: 0,
  recognitionMode: localStorage.getItem('ll-recognition-mode') || 'realtime',
  languageDirection: localStorage.getItem('ll-language-direction') || 'en-zh',
  whisperModel: localStorage.getItem('ll-whisper-model') || 'tiny-en-q5_1',
  whisperInstalled: false,
  whisperStatus: 'not-installed',
  autoScroll: JSON.parse(localStorage.getItem('ll-auto-scroll') ?? 'true'),
  translate: JSON.parse(localStorage.getItem('ll-translate') ?? 'true'),
  translationCache: JSON.parse(localStorage.getItem('ll-translation-cache') ?? '{}'),
  translationCacheSaveTimer: null,
  translationInflight: new Map(),
  interimTranslationController: null,
  draftSaveTimer: null,
  lastWhisperText: '',
  lastWhisperAt: 0
};

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function lessonElapsed() {
  return state.accumulatedMs + (state.isListening && state.startTime ? Date.now() - state.startTime : 0);
}

function startTimer() {
  clearInterval(state.timer);
  state.timer = setInterval(() => { elements.elapsedTime.textContent = formatClock(lessonElapsed()); }, 500);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove('show'), 2200);
}

function setCaptionState(mode, text) {
  elements.subtitleStage.classList.toggle('interim-active', mode === 'interim');
  elements.captionStateBadge.textContent = mode === 'interim' ? '正在講' : mode === 'paused' ? '已暫停' : '最新字幕';
  elements.captionStateText.textContent = text;
}

function captionDensity(text, element) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  const isChinese = element === elements.chineseSubtitle;
  const length = isChinese ? [...clean].length : clean.split(/\s+/).filter(Boolean).length;

  if ((isChinese && length >= 52) || (!isChinese && length >= 30)) return 'caption-xlong';
  if ((isChinese && length >= 36) || (!isChinese && length >= 22)) return 'caption-long';
  if ((isChinese && length >= 24) || (!isChinese && length >= 15)) return 'caption-medium';
  return '';
}

function updateCaptionText(element, text, placeholder = false) {
  const next = text || '';
  const density = captionDensity(next, element);
  const sameText = element.dataset.rawText === next;
  const samePlaceholder = element.classList.contains('placeholder') === placeholder;
  const sameDensity = ['caption-medium', 'caption-long', 'caption-xlong'].every((name) =>
    element.classList.contains(name) === (name === density)
  );
  if (sameText && samePlaceholder && sameDensity) return;

  element.dataset.rawText = next;
  element.classList.add('caption-refresh');
  element.textContent = next;
  element.classList.toggle('placeholder', placeholder);
  element.classList.remove('caption-medium', 'caption-long', 'caption-xlong');
  if (density) element.classList.add(density);
  requestAnimationFrame(() => requestAnimationFrame(() => element.classList.remove('caption-refresh')));
}

function updatePreviousCaption(useLatestCompleted = false) {
  const index = useLatestCompleted ? state.segments.length - 1 : state.segments.length - 2;
  const segment = index >= 0 ? state.segments[index] : null;

  if (!segment) {
    elements.previousCaptionBlock.hidden = true;
    elements.previousChineseSubtitle.textContent = '';
    elements.previousEnglishSubtitle.textContent = '';
    return;
  }

  elements.previousChineseSubtitle.textContent = segment.zh || '';
  elements.previousEnglishSubtitle.textContent = segment.en || '';
  elements.previousCaptionBlock.hidden = !(segment.zh || segment.en);
}

function setSubtitlePlaceholders() {
  if (state.languageDirection === 'zh-en') {
    elements.englishSubtitle.textContent = 'Tap the microphone to translate Chinese into English.';
    elements.chineseSubtitle.textContent = '撳下面咪高峰，開始中文語音辨識';
  } else {
    elements.chineseSubtitle.textContent = '撳下面咪高峰，開始即時字幕';
    elements.englishSubtitle.textContent = 'Tap the microphone to start English recognition.';
  }
  elements.chineseSubtitle.classList.add('placeholder');
  elements.englishSubtitle.classList.add('placeholder');
  elements.chineseSubtitle.classList.remove('caption-medium', 'caption-long', 'caption-xlong');
  elements.englishSubtitle.classList.remove('caption-medium', 'caption-long', 'caption-xlong');
  elements.previousCaptionBlock.hidden = true;
  setCaptionState('idle', '等待開始');
}

function setVisualState(mode) {
  elements.app.classList.toggle('listening', mode === 'listening');
  elements.app.classList.toggle('paused', mode === 'paused');
  elements.liveStatus.className = `live-status ${mode === 'listening' ? 'live' : mode}`;
  elements.statusLabel.textContent = mode === 'listening' ? 'LIVE' : mode === 'paused' ? 'PAUSED' : 'READY';
  elements.micLabel.textContent = mode === 'listening' ? 'Pause' : mode === 'paused' ? 'Resume' : 'Start Listening';
  elements.micButton.setAttribute('aria-label', elements.micLabel.textContent);
  elements.finishButton.hidden = mode === 'idle';
  if (mode === 'paused') setCaptionState('paused', '字幕已保留');
  else if (mode === 'idle') setCaptionState('idle', '等待開始');
}

function createRecognition() {
  if (!SpeechRecognition) return null;
  const recognition = new SpeechRecognition();
  recognition.lang = LANGUAGE_DIRECTIONS[state.languageDirection].speechLang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interim = '';
    let hasFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) { hasFinal = true; addSegment(text); }
      else interim += `${text} `;
    }
    const liveText = interim.trim();
    elements.interimText.textContent = liveText ? '正在辨識下一句…' : '';
    if (liveText && !hasFinal) {
      updatePreviousCaption(true);
      setCaptionState('interim', '字幕會隨說話更新');
      scheduleInterimTranslation(liveText);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      state.shouldRestart = false;
      pauseListening(true);
      showToast('請喺 Safari 設定允許咪高峰');
    } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
      showToast(`語音辨識暫停：${event.error}`);
    }
  };

  recognition.onend = () => {
    if (state.shouldRestart && state.isListening && !state.isPaused) {
      setTimeout(() => { try { recognition.start(); } catch (_) {} }, 250);
    }
  };
  return recognition;
}

function punctuate(text, direction = state.languageDirection) {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  if (direction === 'zh-en') return /[。！？!?]$/.test(clean) ? clean : `${clean}。`;
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

async function startListening() {
  const usesWebSpeech = state.recognitionMode !== 'offline';
  const usesWhisper = RECOGNITION_MODES[state.recognitionMode].needsWhisper;
  if (usesWebSpeech && !SpeechRecognition) {
    showToast('此瀏覽器未支援即時語音；請用 iPhone Safari');
    return;
  }
  if (usesWhisper && !state.whisperInstalled) {
    elements.settingsDialog.showModal();
    showToast('請先下載 Whisper 模型');
    return;
  }
  if (!state.currentLessonId) state.currentLessonId = crypto.randomUUID?.() || String(Date.now());
  if (usesWebSpeech && !state.recognition) state.recognition = createRecognition();
  state.startTime = Date.now();
  state.isListening = true;
  state.isPaused = false;
  state.shouldRestart = true;
  setVisualState('listening');
  startTimer();
  if (usesWebSpeech) {
    try { state.recognition.start(); }
    catch (_) { showToast('正在重新連接咪高峰…'); }
  }
  if (usesWhisper) {
    try {
      await whisper.start();
    } catch (error) {
      if (state.recognitionMode === 'offline') {
        pauseListening(true);
        showToast(error.message || '未能啟動 Whisper');
      } else {
        showToast('Whisper 未能啟動，繼續使用即時模式');
      }
    }
  }
}

function pauseListening(fromError = false) {
  if (state.startTime) state.accumulatedMs += Date.now() - state.startTime;
  state.startTime = null;
  state.isListening = false;
  state.isPaused = true;
  state.shouldRestart = false;
  state.interimToken += 1;
  state.interimTranslationController?.abort();
  state.interimTranslationController = null;
  state.lastInterim = '';
  state.lastInterimTranslatedText = '';
  clearTimeout(state.interimTimer);
  elements.interimText.textContent = '';
  try { state.recognition?.stop(); } catch (_) {}
  whisper?.stop();
  setVisualState('paused');
  if (!fromError) showToast('已暫停，紀錄仍保留');
}

function resetLesson() {
  state.isListening = false;
  state.isPaused = false;
  state.shouldRestart = false;
  state.startTime = null;
  state.accumulatedMs = 0;
  state.currentLessonId = null;
  state.segments = [];
  state.lastWhisperText = '';
  state.lastWhisperAt = 0;
  lessonStore.clearDraft().catch(() => {});
  clearInterval(state.timer);
  elements.elapsedTime.textContent = '00:00:00';
  elements.transcriptList.innerHTML = '';
  elements.transcriptEmpty.hidden = false;
  setSubtitlePlaceholders();
  setVisualState('idle');
}

async function finishLesson() {
  if (state.isListening) pauseListening(true);
  if (!state.segments.length) { resetLesson(); return; }
  const lesson = {
    id: state.currentLessonId,
    createdAt: new Date().toISOString(),
    durationMs: lessonElapsed(),
    title: (state.segments[0]?.en || state.segments[0]?.zh || 'LiveLingo lesson').slice(0, 48),
    segments: state.segments
  };

  try {
    await lessonStore.saveLesson(lesson);
    await lessonStore.clearDraft();
    showToast('課堂紀錄已儲存喺本機');
    resetLesson();
  } catch (error) {
    console.warn('[LiveLingo] Lesson save failed', error);
    showToast('未能儲存課堂，內容仍然保留');
  }
}

async function addSegment(rawText, source = 'web') {
  state.interimToken += 1;
  state.interimTranslationController?.abort();
  state.interimTranslationController = null;
  state.lastInterim = '';
  state.lastInterimTranslatedText = '';
  clearTimeout(state.interimTimer);
  const direction = state.languageDirection;
  const sourceText = punctuate(rawText, direction);
  const sourceField = direction === 'en-zh' ? 'en' : 'zh';
  const duplicate = state.segments.at(-1)?.[sourceField] === sourceText;
  if (!sourceText || duplicate) return;
  const segment = {
    id: `${Date.now()}-${state.segments.length}`, atMs: lessonElapsed(), en: direction === 'en-zh' ? sourceText : '',
    zh: direction === 'zh-en' ? sourceText : '', direction, translating: state.translate, source, corrected: false, translationToken: 0
  };
  state.segments.push(segment);
  renderSegment(segment);
  updateStage(segment);
  persistDraft();
  if (state.translate) {
    const token = ++segment.translationToken;
    const translated = await translateText(sourceText, direction, { notify: true });
    if (token !== segment.translationToken) return;
    if (translated) {
      if (direction === 'en-zh') segment.zh = translated; else segment.en = translated;
    }
    segment.translating = false;
    updateSegment(segment);
    updateStage(segment);
    persistDraft();
  } else {
    segment.translating = false;
    updateSegment(segment);
  }
}

function normalizeEnglishForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(text) {
  return new Set(normalizeEnglishForMatch(text).split(' ').filter((word) => word.length > 1));
}

function textSimilarity(a, b) {
  const aWords = wordSet(a);
  const bWords = wordSet(b);
  if (!aWords.size || !bWords.size) return 0;

  let intersection = 0;
  aWords.forEach((word) => { if (bWords.has(word)) intersection += 1; });
  const union = new Set([...aWords, ...bWords]).size;
  const jaccard = union ? intersection / union : 0;
  const containment = intersection / Math.max(1, Math.min(aWords.size, bWords.size));
  return (jaccard * 0.6) + (containment * 0.4);
}

function normalizedWord(word) {
  return String(word || '').toLowerCase().replace(/[^a-z0-9']/g, '');
}

function trimWhisperOverlap(previousText, currentText) {
  const previousWords = String(previousText || '').trim().split(/\s+/).filter(Boolean);
  const currentWords = String(currentText || '').trim().split(/\s+/).filter(Boolean);
  if (previousWords.length < 2 || currentWords.length < 2) return currentText;

  const previousNormalized = previousWords.map(normalizedWord);
  const currentNormalized = currentWords.map(normalizedWord);
  const maxOverlap = Math.min(10, previousNormalized.length, currentNormalized.length);

  for (let size = maxOverlap; size >= 2; size -= 1) {
    const previousSuffix = previousNormalized.slice(-size);
    const currentPrefix = currentNormalized.slice(0, size);
    if (previousSuffix.every((word, index) => word && word === currentPrefix[index])) {
      return currentWords.slice(size).join(' ');
    }
  }

  return currentText;
}

function findWhisperCorrectionWindow(whisperText, candidates) {
  let best = null;
  const maxWindow = Math.min(3, candidates.length);

  for (let size = 1; size <= maxWindow; size += 1) {
    for (let start = 0; start <= candidates.length - size; start += 1) {
      const group = candidates.slice(start, start + size);
      const combined = group.map((segment) => segment.en).join(' ');
      const similarity = textSimilarity(whisperText, combined);
      const recencyBonus = start + size === candidates.length ? 0.04 : 0;
      const score = similarity + recencyBonus;
      if (!best || score > best.score) best = { group, score, similarity };
    }
  }

  return best;
}

async function correctRecentWithWhisper(rawText) {
  if (state.languageDirection !== 'en-zh') return;
  const en = punctuate(rawText, 'en-zh');
  if (!en) return;

  const now = lessonElapsed();
  const candidates = state.segments.filter((segment) =>
    !segment.corrected &&
    segment.source === 'web' &&
    (segment.direction || 'en-zh') === 'en-zh' &&
    segment.atMs >= Math.max(0, now - 12000)
  );

  if (!candidates.length) {
    await addSegment(en, 'whisper');
    return;
  }

  const match = findWhisperCorrectionWindow(en, candidates);
  if (!match || match.similarity < 0.24) {
    await addSegment(en, 'whisper');
    return;
  }

  const [primary, ...merged] = match.group;
  primary.translationToken = (primary.translationToken || 0) + 1;
  primary.en = en;
  primary.source = 'smart';
  primary.corrected = true;
  primary.direction = 'en-zh';
  primary.translating = state.translate;
  primary.zh = '';

  merged.forEach((segment) => {
    segment.translationToken = (segment.translationToken || 0) + 1;
    elements.transcriptList.querySelector(`[data-id="${CSS.escape(segment.id)}"]`)?.remove();
  });

  if (merged.length) {
    const removedIds = new Set(merged.map((segment) => segment.id));
    state.segments = state.segments.filter((segment) => !removedIds.has(segment.id));
  }

  updateSegment(primary);
  updateStage(primary);
  persistDraft();

  if (state.translate) {
    const token = ++primary.translationToken;
    const translated = await translateText(en, 'en-zh', { notify: true });
    if (token !== primary.translationToken) return;
    if (translated) primary.zh = translated;
    primary.translating = false;
    updateSegment(primary);
    updateStage(primary);
    persistDraft();
  }
}

function handleWhisperTranscript(text) {
  if (!state.isListening || state.isPaused || state.languageDirection !== 'en-zh') return;

  const now = Date.now();
  const nearDuplicate = state.lastWhisperText &&
    now - state.lastWhisperAt < 8000 &&
    textSimilarity(text, state.lastWhisperText) >= 0.96;

  if (nearDuplicate) return;

  state.lastWhisperText = text;
  state.lastWhisperAt = now;

  if (state.recognitionMode === 'offline') {
    const previousWhisper = [...state.segments].reverse().find((segment) =>
      (segment.source === 'whisper' || segment.source === 'smart') &&
      (segment.direction || 'en-zh') === 'en-zh'
    );
    const novelText = trimWhisperOverlap(previousWhisper?.en || '', text).trim();
    if (novelText) addSegment(novelText, 'whisper');
  }

  if (state.recognitionMode === 'smart') setTimeout(() => correctRecentWithWhisper(text), 650);
}

function interimTranslationDelay(text) {
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const sentenceEnded = /[.!?。！？]$/.test(trimmed);

  if (sentenceEnded) return 180;
  if (wordCount <= 3) return 260;
  if (wordCount <= 8) return 340;
  if (wordCount <= 16) return 430;
  return 520;
}

function scheduleInterimTranslation(text) {
  if (!state.translate || text.length < 3 || text === state.lastInterim) return;
  state.interimTranslationController?.abort();
  state.interimTranslationController = null;
  state.lastInterim = text;
  const direction = state.languageDirection;
  clearTimeout(state.interimTimer);
  const token = ++state.interimToken;

  if (direction === 'en-zh') {
    updateCaptionText(elements.englishSubtitle, text, false);
    if (!elements.chineseSubtitle.textContent || elements.chineseSubtitle.classList.contains('placeholder')) {
      updateCaptionText(elements.chineseSubtitle, '即時翻譯中…', true);
    }
  } else {
    updateCaptionText(elements.chineseSubtitle, text, false);
    if (!elements.englishSubtitle.textContent || elements.englishSubtitle.classList.contains('placeholder')) {
      updateCaptionText(elements.englishSubtitle, 'Translating…', true);
    }
  }

  const now = Date.now();
  const minimumRequestGap = 450;
  const sinceLastRequest = now - state.lastInterimRequestAt;
  const throttleDelay = Math.max(0, minimumRequestGap - sinceLastRequest);

  let delay = Math.max(interimTranslationDelay(text), throttleDelay);
  const previous = state.lastInterimTranslatedText.trim();
  const current = text.trim();
  if (previous && current.startsWith(previous)) {
    const growth = current.length - previous.length;
    if (growth > 0 && growth < 5) delay = Math.max(delay, 520);
  }

  state.interimTimer = setTimeout(async () => {
    if (token !== state.interimToken || !state.isListening || direction !== state.languageDirection) return;
    state.lastInterimRequestAt = Date.now();
    state.lastInterimTranslatedText = text;
    const controller = new AbortController();
    state.interimTranslationController = controller;

    try {
      const translated = await translateText(text, direction, { signal: controller.signal, notify: false });
      if (!translated || token !== state.interimToken || !state.isListening || direction !== state.languageDirection) return;
      const targetElement = direction === 'en-zh' ? elements.chineseSubtitle : elements.englishSubtitle;
      updateCaptionText(targetElement, translated, false);
      setCaptionState('interim', '即時翻譯');
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('[LiveLingo] Interim translation failed', error);
    } finally {
      if (state.interimTranslationController === controller) state.interimTranslationController = null;
    }
  }, delay);
}

async function fetchJsonWithTimeout(url, timeoutMs = 15000, externalSignal) {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function translateText(text, direction = state.languageDirection, options = {}) {
  const { signal, notify = false } = options;
  const language = LANGUAGE_DIRECTIONS[direction];
  const cacheKey = `${language.source}:${language.target}:${text}`;
  if (state.translationCache[cacheKey]) return state.translationCache[cacheKey];
  if (!signal && state.translationInflight.has(cacheKey)) return state.translationInflight.get(cacheKey);

  const request = (async () => {
    try {
      const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${language.source}&tl=${language.target}&q=${encodeURIComponent(text)}`;
      const data = await fetchJsonWithTimeout(url, 15000, signal);
      const result = Array.isArray(data) ? data.filter((part) => typeof part === 'string').join('') : '';
      if (!result) throw new Error('empty primary translation');
      return cacheTranslation(cacheKey, result);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      console.warn('[LiveLingo] Primary Google translation failed', error);
      try {
        const fallbackUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${language.source}&tl=${language.target}&dt=t&q=${encodeURIComponent(text)}`;
        const fallbackData = await fetchJsonWithTimeout(fallbackUrl, 12000, signal);
        const result = fallbackData[0].map((part) => part[0]).join('');
        if (!result) throw new Error('empty Google fallback');
        return cacheTranslation(cacheKey, result);
      } catch (fallbackError) {
        if (signal?.aborted || fallbackError?.name === 'AbortError') throw fallbackError;
        console.warn('[LiveLingo] Google fallback translation failed', fallbackError);
        try {
          const lastFallbackUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${language.source}|${language.target}`;
          const lastFallbackData = await fetchJsonWithTimeout(lastFallbackUrl, 12000, signal);
          const result = lastFallbackData.responseData?.translatedText;
          if (!result) throw new Error('empty MyMemory fallback');
          return cacheTranslation(cacheKey, result);
        } catch (lastFallbackError) {
          if (signal?.aborted || lastFallbackError?.name === 'AbortError') throw lastFallbackError;
          console.warn('[LiveLingo] MyMemory fallback translation failed', lastFallbackError);
          if (notify) showToast(`翻譯服務暫時連唔到，${direction === 'en-zh' ? '英文' : '中文'}已保存`);
          return null;
        }
      }
    }
  })();

  if (!signal) state.translationInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (!signal) state.translationInflight.delete(cacheKey);
  }
}

function scheduleTranslationCacheSave() {
  clearTimeout(state.translationCacheSaveTimer);
  state.translationCacheSaveTimer = setTimeout(() => {
    localStorage.setItem('ll-translation-cache', JSON.stringify(state.translationCache));
  }, 1500);
}

function cacheTranslation(cacheKey, result) {
  state.translationCache[cacheKey] = result;
  const entries = Object.entries(state.translationCache).slice(-400);
  state.translationCache = Object.fromEntries(entries);
  scheduleTranslationCacheSave();
  return result;
}

function renderSegment(segment) {
  elements.transcriptEmpty.hidden = true;
  const li = document.createElement('li');
  li.className = 'transcript-item';
  li.dataset.id = segment.id;
  li.innerHTML = `<time class="transcript-time">${formatClock(segment.atMs).slice(3)}</time><div class="transcript-copy"><p class="zh"></p><p class="en"></p><small class="correction-label" hidden>✓ Whisper 校正</small></div>`;
  elements.transcriptList.appendChild(li);
  updateSegment(segment);
  if (state.autoScroll) li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function updateSegment(segment) {
  const item = elements.transcriptList.querySelector(`[data-id="${CSS.escape(segment.id)}"]`);
  if (!item) return;
  const zh = item.querySelector('.zh');
  const en = item.querySelector('.en');
  const direction = segment.direction || 'en-zh';
  zh.textContent = segment.zh || (segment.translating && direction === 'en-zh' ? '翻譯中…' : '');
  en.textContent = segment.en || (segment.translating && direction === 'zh-en' ? 'Translating…' : '');
  zh.classList.toggle('translating', segment.translating && direction === 'en-zh');
  en.classList.toggle('translating', segment.translating && direction === 'zh-en');
  const correctionLabel = item.querySelector('.correction-label');
  correctionLabel.hidden = !segment.corrected;
}

function updateStage(segment) {
  if (segment !== state.segments.at(-1)) return;
  updatePreviousCaption(false);
  const direction = segment.direction || 'en-zh';
  updateCaptionText(
    elements.englishSubtitle,
    segment.en || (segment.translating && direction === 'zh-en' ? 'Translating…' : ''),
    segment.translating && direction === 'zh-en'
  );
  updateCaptionText(
    elements.chineseSubtitle,
    segment.zh || (segment.translating && direction === 'en-zh' ? '翻譯中…' : ''),
    segment.translating && direction === 'en-zh'
  );
  setCaptionState(segment.translating ? 'interim' : 'complete', segment.translating ? '翻譯處理中' : '已完成');
}

function transcriptText(segments = state.segments) {
  return segments.map((s) => {
    const lines = (s.direction || 'en-zh') === 'zh-en' ? [s.zh, s.en] : [s.en, s.zh];
    return `${formatClock(s.atMs).slice(3)}\n${lines.filter(Boolean).join('\n')}`;
  }).join('\n\n');
}

function exportText(segments, options = {}) {
  const createdAt = new Date(options.createdAt || Date.now());
  const title = options.title || 'LiveLingo 課堂內容';
  const dateLabel = new Intl.DateTimeFormat('zh-HK', { dateStyle: 'long', timeStyle: 'short' }).format(createdAt);
  return `${title}\n${dateLabel}\n\n${transcriptText(segments)}`;
}

function exportFilename(createdAt = new Date()) {
  const stamp = new Date(createdAt).toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  return `LiveLingo-${stamp}.txt`;
}

async function exportLesson(segments = state.segments, options = {}) {
  if (!segments.length) { showToast('暫時未有課堂內容可以輸出'); return; }
  const content = exportText(segments, options);
  const filename = exportFilename(options.createdAt);
  const file = new File([content], filename, { type: 'text/plain;charset=utf-8' });

  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: options.title || 'LiveLingo 課堂內容', files: [file] });
      showToast('課堂內容已輸出');
      return;
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('課堂文字檔已下載');
  } catch (error) {
    if (error?.name !== 'AbortError') showToast('未能輸出，請再試一次');
  }
}

function openExportOptions(segments = state.segments, options = {}) {
  if (!segments.length) { showToast('暫時未有課堂內容可以輸出'); return; }
  state.pendingExport = { segments: [...segments], options: { ...options } };
  el('exportDialog').showModal();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function pdfDocumentHtml(segments, options = {}) {
  const createdAt = new Date(options.createdAt || Date.now());
  const title = options.title || 'LiveLingo 課堂內容';
  const dateLabel = new Intl.DateTimeFormat('zh-HK', { dateStyle: 'long', timeStyle: 'short' }).format(createdAt);
  const rows = segments.map((segment) => `<section><time>${escapeHtml(formatClock(segment.atMs).slice(3))}</time><div><p class="zh">${escapeHtml(segment.zh)}</p><p class="en">${escapeHtml(segment.en)}</p></div></section>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>@page{size:A4;margin:18mm}*{box-sizing:border-box}body{margin:0;color:#101828;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}header{padding-bottom:18px;border-bottom:2px solid #ff5b54}h1{margin:0;font-size:26px}header p{margin:7px 0 0;color:#667085}main{margin-top:8px}section{display:grid;grid-template-columns:62px 1fr;gap:14px;padding:15px 0;border-bottom:1px solid #e4e7ec;break-inside:avoid}time{padding-top:4px;color:#ff5b54;font-size:12px;font-variant-numeric:tabular-nums}p{margin:0;line-height:1.5}.zh{font-size:17px;font-weight:650}.en{margin-top:5px;color:#667085;font-size:14px}footer{margin-top:22px;color:#98a2b3;font-size:11px;text-align:center}@media print{button{display:none}}</style></head><body><header><h1>${escapeHtml(title)}</h1><p>${escapeHtml(dateLabel)} · ${segments.length} 段字幕</p></header><main>${rows}</main><footer>Exported from LiveLingo</footer></body></html>`;
}

function exportPdf(segments = state.segments, options = {}) {
  if (!segments.length) { showToast('暫時未有課堂內容可以輸出'); return; }
  const printWindow = window.open('', '_blank');
  if (!printWindow) { showToast('請允許彈出式視窗以輸出 PDF'); return; }
  printWindow.document.open();
  printWindow.document.write(pdfDocumentHtml(segments, options));
  printWindow.document.close();
  setTimeout(() => {
    printWindow.focus();
    printWindow.print();
  }, 350);
}

async function copyText(text, success = '已複製字幕內容') {
  if (!text) { showToast('暫時未有字幕可以複製'); return; }
  try { await navigator.clipboard.writeText(text); showToast(success); }
  catch (_) { showToast('未能複製，請再試一次'); }
}

async function writeDraftNow() {
  if (!state.currentLessonId) return;
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = null;
  const draft = {
    id: state.currentLessonId,
    durationMs: lessonElapsed(),
    segments: state.segments
  };
  try {
    await lessonStore.saveDraft(draft);
  } catch (error) {
    console.warn('[LiveLingo] Draft save failed', error);
  }
}

function persistDraft() {
  if (!state.currentLessonId) return;
  clearTimeout(state.draftSaveTimer);
  state.draftSaveTimer = setTimeout(() => { writeDraftNow(); }, 900);
}

async function restoreDraft() {
  try {
    const draft = await lessonStore.getDraft();
    if (!draft?.id || !draft.segments?.length) return;
    state.currentLessonId = draft.id;
    state.accumulatedMs = draft.durationMs || 0;
    state.segments = draft.segments;
    const draftDirection = state.segments.at(-1)?.direction;
    if (LANGUAGE_DIRECTIONS[draftDirection]) {
      state.languageDirection = draftDirection;
      localStorage.setItem('ll-language-direction', draftDirection);
      updateLanguageDirectionUI();
    }
    elements.elapsedTime.textContent = formatClock(state.accumulatedMs);
    state.segments.forEach((segment) => { renderSegment(segment); updateSegment(segment); });
    updateStage(state.segments.at(-1));
    state.isPaused = true;
    setVisualState('paused');
    showToast('已恢復上次未完成課堂');
  } catch (error) {
    console.warn('[LiveLingo] Draft restore failed', error);
  }
}

async function renderHistory() {
  elements.historyList.innerHTML = '<div class="history-empty">正在載入課堂紀錄…</div>';
  let lessons = [];
  try {
    lessons = await lessonStore.getLessons();
  } catch (error) {
    console.warn('[LiveLingo] History load failed', error);
    elements.historyList.innerHTML = '<div class="history-empty">未能載入課堂紀錄，請重新開啟 App。</div>';
    return;
  }

  elements.historyList.innerHTML = '';
  if (!lessons.length) {
    elements.historyList.innerHTML = '<div class="history-empty">未有課堂紀錄。<br>完成第一堂後會自動存在呢部裝置。</div>';
    return;
  }

  lessons.forEach((lesson) => {
    const button = document.createElement('button');
    button.className = 'history-item';
    const date = new Intl.DateTimeFormat('zh-HK', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lesson.createdAt));
    button.innerHTML = `<span><strong></strong><small>${date} · ${lesson.segments.length} 段字幕</small></span><span class="history-duration">${formatClock(lesson.durationMs).slice(3)} ›</span>`;
    button.querySelector('strong').textContent = lesson.title;
    button.addEventListener('click', () => openLesson(lesson));
    elements.historyList.appendChild(button);
  });
}

function openLesson(lesson) {
  elements.historyDialog.close();
  el('lessonTitle').textContent = lesson.title;
  el('lessonMeta').textContent = new Intl.DateTimeFormat('zh-HK', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(lesson.createdAt));
  el('lessonContent').innerHTML = '';
  lesson.segments.forEach((segment) => {
    const div = document.createElement('div');
    div.className = 'lesson-line';
    div.innerHTML = '<p class="zh"></p><p class="en"></p>';
    div.querySelector('.zh').textContent = segment.zh;
    div.querySelector('.en').textContent = segment.en;
    el('lessonContent').appendChild(div);
  });
  el('copyLessonButton').onclick = () => copyText(transcriptText(lesson.segments));
  el('exportLessonButton').onclick = () => openExportOptions(lesson.segments, { createdAt: lesson.createdAt, title: lesson.title });
  elements.lessonDialog.showModal();
}

function updateLanguageDirectionUI() {
  if (!LANGUAGE_DIRECTIONS[state.languageDirection]) state.languageDirection = 'en-zh';
  const input = document.querySelector(`input[name="languageDirection"][value="${state.languageDirection}"]`);
  if (input) input.checked = true;
  const chineseToEnglish = state.languageDirection === 'zh-en';
  document.body.classList.toggle('zh-to-en', chineseToEnglish);
  elements.translationDirectionLabel.textContent = LANGUAGE_DIRECTIONS[state.languageDirection].label;
  elements.largeModeLabel.textContent = chineseToEnglish ? '英文大字幕' : '中文大字幕';
  elements.languageDirectionNote.textContent = chineseToEnglish
    ? '中文語音使用瀏覽器即時辨識；英文 Whisper 模型不適用於中文。'
    : '可使用即時、智能校正或離線辨識模式。';
  elements.languageDirectionNote.classList.toggle('warning', chineseToEnglish);
  document.querySelectorAll('input[name="recognitionMode"]').forEach((modeInput) => {
    modeInput.disabled = chineseToEnglish && modeInput.value !== 'realtime';
  });
  if (chineseToEnglish && state.recognitionMode !== 'realtime') {
    state.recognitionMode = 'realtime';
    localStorage.setItem('ll-recognition-mode', 'realtime');
  }
  updateRecognitionModeUI();
  if (!state.segments.length) setSubtitlePlaceholders();
}

function whisperCompatible() {
  return Boolean(window.WebAssembly && navigator.mediaDevices?.getUserMedia);
}

function updateRecognitionModeUI() {
  const mode = RECOGNITION_MODES[state.recognitionMode] ? state.recognitionMode : 'realtime';
  state.recognitionMode = mode;
  document.querySelector(`input[name="recognitionMode"][value="${mode}"]`).checked = true;
  elements.activeModeBadge.textContent = RECOGNITION_MODES[mode].label;
  elements.whisperModelCard.hidden = !RECOGNITION_MODES[mode].needsWhisper;
  if (RECOGNITION_MODES[mode].needsWhisper) updateWhisperUI();
}

function updateWhisperUI(status = state.whisperStatus, detail = '') {
  state.whisperStatus = status;
  const model = WHISPER_MODELS[state.whisperModel];
  const busy = ['downloading', 'preparing', 'loading-model'].includes(status);
  elements.whisperModelName.textContent = `Whisper ${model.name}`;
  elements.whisperModelDetail.textContent = `英文模型 · 約 ${model.sizeMb} MB`;
  elements.downloadWhisperButton.textContent = `下載模型（${model.sizeMb} MB）`;
  const labels = {
    'not-installed': '未下載', downloading: '下載中', 'loading-model': '載入中', ready: '已準備',
    listening: '聆聽中', transcribing: '校正中', preparing: '準備中', downloaded: '已下載',
    error: '發生錯誤', 'runtime-error': '核心錯誤', runtime: '啟動中'
  };
  elements.whisperStatus.textContent = labels[status] || (state.whisperInstalled ? '已準備' : '未下載');
  elements.whisperStatus.classList.toggle('ready', ['ready', 'listening', 'transcribing'].includes(status));
  elements.downloadWhisperButton.hidden = state.whisperInstalled;
  elements.deleteWhisperButton.hidden = !state.whisperInstalled;
  if (!whisperCompatible()) {
    elements.whisperCompatibility.textContent = '這個瀏覽器不支援 Whisper 所需的音訊或 WebAssembly 功能。';
    elements.whisperCompatibility.classList.add('warning');
    elements.downloadWhisperButton.disabled = true;
  } else if (!window.crossOriginIsolated) {
    elements.whisperCompatibility.textContent = '首次更新後請完全關閉並重新開啟 App，才可啟用 Whisper 安全運算模式。';
    elements.whisperCompatibility.classList.add('warning');
    elements.downloadWhisperButton.disabled = false;
  } else {
    const isSmallModel = state.whisperModel === 'small-en-q5_1';
    elements.whisperCompatibility.textContent = detail || (isSmallModel
      ? 'Small 模型約 181 MB，準確度較高但需要更多記憶體及運算；較適合新款 iPhone，長時間使用可能較熱。'
      : '模型只會存在這部裝置，錄音不會上傳。');
    elements.whisperCompatibility.classList.toggle('warning', isSmallModel);
    elements.downloadWhisperButton.disabled = false;
  }
  if (busy) {
    elements.downloadWhisperButton.disabled = true;
    elements.downloadWhisperButton.textContent = status === 'downloading' ? '正在下載…' : '正在準備…';
  }
}

async function refreshWhisperModelState() {
  if (!whisper) return;
  if (!WHISPER_MODELS[state.whisperModel]) state.whisperModel = 'tiny-en-q5_1';
  whisper.setModel(state.whisperModel);
  const input = document.querySelector(`input[name="whisperModel"][value="${state.whisperModel}"]`);
  if (input) input.checked = true;
  state.whisperInstalled = await whisper.hasModel(state.whisperModel);
  updateWhisperUI(state.whisperInstalled ? 'ready' : 'not-installed');
}

async function downloadWhisperModel() {
  if (!whisperCompatible()) { showToast('此瀏覽器未能運行 Whisper'); return; }

  const model = WHISPER_MODELS[state.whisperModel];
  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const available = Math.max(0, (estimate.quota || 0) - (estimate.usage || 0));
      const required = model.sizeMb * 1048576 * 1.25;
      if (estimate.quota && available < required) {
        showToast(`儲存空間不足，${model.name} 建議預留約 ${Math.ceil(model.sizeMb * 1.25)} MB`);
        return;
      }
    } catch (_) {}
  }

  updateWhisperUI('downloading');
  elements.downloadWhisperButton.disabled = true;
  elements.downloadWhisperButton.textContent = '正在下載…';
  elements.whisperProgress.hidden = false;
  elements.whisperProgress.classList.add('indeterminate');
  elements.whisperProgressText.hidden = false;
  elements.whisperProgressText.textContent = '正在連接模型伺服器…';
  elements.whisperProgressBar.style.width = '0%';
  try {
    await whisper.downloadModel((progress, received, total, stage) => {
      const percent = progress ? Math.round(progress * 100) : 0;
      const receivedMb = received / 1048576;
      const totalMb = (total || WHISPER_MODELS[state.whisperModel].sizeMb * 1048576) / 1048576;
      elements.whisperProgress.classList.toggle('indeterminate', stage === 'preparing');
      elements.whisperProgressBar.style.width = `${percent}%`;
      elements.whisperStatus.textContent = percent ? `${percent}%` : `${Math.round(received / 1048576)} MB`;
      elements.whisperProgressText.textContent = stage === 'preparing'
        ? '模型已保存，正在啟動 Whisper 運算核心…'
        : stage === 'ready' ? `下載完成 · ${receivedMb.toFixed(1)} MB`
          : `已下載 ${receivedMb.toFixed(1)} / ${totalMb.toFixed(1)} MB`;
    });
    state.whisperInstalled = true;
    updateWhisperUI('ready');
    elements.whisperProgress.classList.remove('indeterminate');
    elements.whisperProgressBar.style.width = '100%';
    showToast('Whisper 模型已準備');
  } catch (error) {
    state.whisperInstalled = await whisper.hasModel(state.whisperModel);
    updateWhisperUI(state.whisperInstalled ? 'downloaded' : 'error', error.message);
    elements.whisperProgress.classList.remove('indeterminate');
    elements.whisperProgressText.textContent = state.whisperInstalled
      ? `模型已下載，但運算核心未啟動：${error.message}`
      : error.message;
    showToast(state.whisperInstalled ? '模型已下載，請完全關閉再開啟 App' : error.message);
  } finally {
    elements.downloadWhisperButton.disabled = false;
  }
}

async function deleteWhisperModel() {
  const model = WHISPER_MODELS[state.whisperModel];
  if (!confirm(`確定刪除 ${model.sizeMb} MB ${model.name} 模型？之後使用時需要重新下載。`)) return;
  await whisper.deleteModel(state.whisperModel);
  state.whisperInstalled = false;
  updateWhisperUI('not-installed');
  showToast('Whisper 模型已刪除');
}

elements.micButton.addEventListener('click', () => {
  if (state.isListening) pauseListening(); else startListening();
});
elements.finishButton.addEventListener('click', finishLesson);
elements.copyButton.addEventListener('click', () => copyText(transcriptText()));
elements.exportButton.addEventListener('click', () => openExportOptions());
el('exportTxtButton').addEventListener('click', () => {
  const pending = state.pendingExport;
  el('exportDialog').close();
  if (pending) exportLesson(pending.segments, pending.options);
});
el('exportPdfButton').addEventListener('click', () => {
  const pending = state.pendingExport;
  el('exportDialog').close();
  if (pending) exportPdf(pending.segments, pending.options);
});
elements.largeModeButton.addEventListener('click', () => {
  const enabled = !document.body.classList.contains('large-mode');
  document.body.classList.toggle('large-mode', enabled);
  elements.largeModeButton.setAttribute('aria-pressed', String(enabled));
});
el('historyButton').addEventListener('click', () => { elements.historyDialog.showModal(); renderHistory(); });
el('settingsButton').addEventListener('click', () => elements.settingsDialog.showModal());
el('brandButton').addEventListener('click', () => document.body.classList.remove('large-mode'));
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => el(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
}));

el('autoScrollToggle').checked = state.autoScroll;
el('translationToggle').checked = state.translate;
el('versionLabel').textContent = `v${APP_VERSION}`;
el('autoScrollToggle').addEventListener('change', (event) => { state.autoScroll = event.target.checked; localStorage.setItem('ll-auto-scroll', state.autoScroll); });
el('translationToggle').addEventListener('change', (event) => {
  state.translate = event.target.checked;
  localStorage.setItem('ll-translate', state.translate);
  if (!state.translate) {
    state.interimTranslationController?.abort();
    state.interimTranslationController = null;
  }
});
document.querySelectorAll('input[name="languageDirection"]').forEach((input) => input.addEventListener('change', (event) => {
  if (state.isListening) pauseListening(true);
  try { state.recognition?.abort(); } catch (_) {}
  state.recognition = null;
  state.languageDirection = event.target.value;
  localStorage.setItem('ll-language-direction', state.languageDirection);
  updateLanguageDirectionUI();
  showToast(state.languageDirection === 'zh-en' ? '已轉為中文語音 → 英文' : '已轉為英文語音 → 繁體中文');
}));
document.querySelectorAll('input[name="recognitionMode"]').forEach((input) => input.addEventListener('change', (event) => {
  if (state.isListening) pauseListening(true);
  state.recognitionMode = event.target.value;
  localStorage.setItem('ll-recognition-mode', state.recognitionMode);
  updateRecognitionModeUI();
  if (RECOGNITION_MODES[state.recognitionMode].needsWhisper && !state.whisperInstalled) showToast(`首次使用要下載 ${WHISPER_MODELS[state.whisperModel].sizeMb} MB 模型`);
}));
document.querySelectorAll('input[name="whisperModel"]').forEach((input) => input.addEventListener('change', async (event) => {
  if (state.isListening) pauseListening(true);
  state.whisperModel = event.target.value;
  localStorage.setItem('ll-whisper-model', state.whisperModel);
  whisper.setModel(state.whisperModel);
  state.whisperInstalled = await whisper.hasModel(state.whisperModel);
  elements.whisperProgress.hidden = true;
  elements.whisperProgressText.hidden = true;
  updateWhisperUI(state.whisperInstalled ? 'ready' : 'not-installed');
  showToast(state.whisperInstalled ? `${WHISPER_MODELS[state.whisperModel].name} 已準備` : `需要下載 ${WHISPER_MODELS[state.whisperModel].sizeMb} MB 模型`);
}));
elements.downloadWhisperButton.addEventListener('click', downloadWhisperModel);
elements.deleteWhisperButton.addEventListener('click', deleteWhisperModel);
el('clearHistoryButton').addEventListener('click', async () => {
  if (!confirm('確定清除所有本機課堂紀錄？')) return;
  try {
    await lessonStore.clearLessons();
    await renderHistory();
    showToast('所有紀錄已清除');
  } catch (error) {
    console.warn('[LiveLingo] History clear failed', error);
    showToast('未能清除課堂紀錄');
  }
});

window.addEventListener('pagehide', () => { writeDraftNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) writeDraftNow(); });

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
whisper?.setTranscriptHandler(handleWhisperTranscript);
whisper?.setStatusHandler(({ status, detail }) => {
  if (status === 'runtime-ready' && state.whisperInstalled) updateWhisperUI('ready');
  else if (['downloading', 'loading-model', 'preparing', 'ready', 'listening', 'transcribing', 'not-installed', 'runtime-error'].includes(status)) updateWhisperUI(status, detail);
});
updateLanguageDirectionUI();
refreshWhisperModelState();
setVisualState('idle');

(async () => {
  try {
    await lessonStore.init();
    await restoreDraft();
  } catch (error) {
    console.warn('[LiveLingo] Local database initialization failed', error);
    showToast('本機課堂資料庫暫時未能啟動');
  }
})();
