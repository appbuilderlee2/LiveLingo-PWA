const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const APP_VERSION = '1.7.0';
const whisper = window.LiveLingoWhisper;
const WHISPER_MODELS = whisper?.models || {
  'tiny-en-q5_1': { name: 'tiny.en Q5_1', sizeMb: 31 },
  'base-en-q5_1': { name: 'base.en Q5_1', sizeMb: 57 }
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
  translationDirectionLabel: el('translationDirectionLabel'), languageDirectionNote: el('languageDirectionNote'), largeModeLabel: el('largeModeLabel')
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
  recognitionMode: localStorage.getItem('ll-recognition-mode') || 'realtime',
  languageDirection: localStorage.getItem('ll-language-direction') || 'en-zh',
  whisperModel: localStorage.getItem('ll-whisper-model') || 'tiny-en-q5_1',
  whisperInstalled: false,
  whisperStatus: 'not-installed',
  autoScroll: JSON.parse(localStorage.getItem('ll-auto-scroll') ?? 'true'),
  translate: JSON.parse(localStorage.getItem('ll-translate') ?? 'true'),
  translationCache: JSON.parse(localStorage.getItem('ll-translation-cache') ?? '{}')
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
}

function setVisualState(mode) {
  elements.app.classList.toggle('listening', mode === 'listening');
  elements.app.classList.toggle('paused', mode === 'paused');
  elements.liveStatus.className = `live-status ${mode === 'listening' ? 'live' : mode}`;
  elements.statusLabel.textContent = mode === 'listening' ? 'LIVE' : mode === 'paused' ? 'PAUSED' : 'READY';
  elements.micLabel.textContent = mode === 'listening' ? 'Pause' : mode === 'paused' ? 'Resume' : 'Start Listening';
  elements.micButton.setAttribute('aria-label', elements.micLabel.textContent);
  elements.finishButton.hidden = mode === 'idle';
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
    elements.interimText.textContent = liveText ? `Listening: ${liveText}` : '';
    if (liveText && !hasFinal) scheduleInterimTranslation(liveText);
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
  state.lastInterim = '';
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
  localStorage.removeItem('ll-draft');
  clearInterval(state.timer);
  elements.elapsedTime.textContent = '00:00:00';
  elements.transcriptList.innerHTML = '';
  elements.transcriptEmpty.hidden = false;
  setSubtitlePlaceholders();
  setVisualState('idle');
}

function finishLesson() {
  if (state.isListening) pauseListening(true);
  if (!state.segments.length) { resetLesson(); return; }
  const lessons = getLessons();
  const lesson = {
    id: state.currentLessonId,
    createdAt: new Date().toISOString(),
    durationMs: lessonElapsed(),
    title: (state.segments[0]?.en || state.segments[0]?.zh || 'LiveLingo lesson').slice(0, 48),
    segments: state.segments
  };
  const existing = lessons.findIndex((item) => item.id === lesson.id);
  if (existing >= 0) lessons[existing] = lesson; else lessons.unshift(lesson);
  localStorage.setItem('ll-lessons', JSON.stringify(lessons.slice(0, 50)));
  showToast('課堂紀錄已儲存喺本機');
  resetLesson();
}

async function addSegment(rawText, source = 'web') {
  state.interimToken += 1;
  state.lastInterim = '';
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
    const translated = await translateText(sourceText, direction);
    if (token !== segment.translationToken) return;
    if (direction === 'en-zh') segment.zh = translated; else segment.en = translated;
    segment.translating = false;
    updateSegment(segment);
    updateStage(segment);
    persistDraft();
  } else {
    segment.translating = false;
    updateSegment(segment);
  }
}

async function correctRecentWithWhisper(rawText) {
  if (state.languageDirection !== 'en-zh') return;
  const en = punctuate(rawText, 'en-zh');
  if (!en) return;
  const now = lessonElapsed();
  const candidates = state.segments.filter((segment) => !segment.corrected && segment.source === 'web' && (segment.direction || 'en-zh') === 'en-zh' && segment.atMs >= Math.max(0, now - 10000));
  if (!candidates.length) {
    await addSegment(en, 'whisper');
    return;
  }

  const primary = candidates[0];
  primary.translationToken = (primary.translationToken || 0) + 1;
  primary.en = en;
  primary.source = 'smart';
  primary.corrected = true;
  primary.direction = 'en-zh';
  primary.translating = state.translate;
  primary.zh = '';

  candidates.slice(1).forEach((segment) => {
    segment.translationToken = (segment.translationToken || 0) + 1;
    elements.transcriptList.querySelector(`[data-id="${CSS.escape(segment.id)}"]`)?.remove();
  });
  const removedIds = new Set(candidates.slice(1).map((segment) => segment.id));
  state.segments = state.segments.filter((segment) => !removedIds.has(segment.id));
  updateSegment(primary);
  updateStage(primary);
  persistDraft();

  if (state.translate) {
    const token = ++primary.translationToken;
    const translated = await translateText(en, 'en-zh');
    if (token !== primary.translationToken) return;
    primary.zh = translated;
    primary.translating = false;
    updateSegment(primary);
    updateStage(primary);
    persistDraft();
  }
}

function handleWhisperTranscript(text) {
  if (!state.isListening || state.isPaused || state.languageDirection !== 'en-zh') return;
  if (state.recognitionMode === 'offline') addSegment(text, 'whisper');
  if (state.recognitionMode === 'smart') setTimeout(() => correctRecentWithWhisper(text), 650);
}

function scheduleInterimTranslation(text) {
  if (!state.translate || text.length < 3 || text === state.lastInterim) return;
  state.lastInterim = text;
  const direction = state.languageDirection;
  clearTimeout(state.interimTimer);
  const token = ++state.interimToken;
  if (direction === 'en-zh') {
    elements.englishSubtitle.textContent = text;
    elements.englishSubtitle.classList.remove('placeholder');
    elements.chineseSubtitle.textContent = '即時翻譯中…';
    elements.chineseSubtitle.classList.add('placeholder');
  } else {
    elements.chineseSubtitle.textContent = text;
    elements.chineseSubtitle.classList.remove('placeholder');
    elements.englishSubtitle.textContent = 'Translating…';
    elements.englishSubtitle.classList.add('placeholder');
  }

  state.interimTimer = setTimeout(async () => {
    const translated = await translateText(text, direction);
    if (token !== state.interimToken || !state.isListening || direction !== state.languageDirection) return;
    const targetElement = direction === 'en-zh' ? elements.chineseSubtitle : elements.englishSubtitle;
    targetElement.textContent = translated;
    targetElement.classList.remove('placeholder');
  }, 550);
}

async function translateText(text, direction = state.languageDirection) {
  const language = LANGUAGE_DIRECTIONS[direction];
  const cacheKey = `${language.source}:${language.target}:${text}`;
  if (state.translationCache[cacheKey]) return state.translationCache[cacheKey];
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${language.source}&tl=${language.target}&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('translation unavailable');
    const data = await response.json();
    const result = data[0].map((part) => part[0]).join('');
    return cacheTranslation(cacheKey, result);
  } catch (_) {
    try {
      const fallbackUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${language.source}|${language.target}`;
      const fallbackResponse = await fetch(fallbackUrl);
      if (!fallbackResponse.ok) throw new Error('fallback unavailable');
      const fallbackData = await fallbackResponse.json();
      const result = fallbackData.responseData?.translatedText;
      if (!result) throw new Error('empty fallback');
      return cacheTranslation(cacheKey, result);
    } catch (_) {
      showToast(`翻譯服務暫時連唔到，${direction === 'en-zh' ? '英文' : '中文'}已保存`);
      return direction === 'en-zh' ? '（翻譯暫時未能顯示）' : '(Translation unavailable)';
    }
  }
}

function cacheTranslation(cacheKey, result) {
    state.translationCache[cacheKey] = result;
    const entries = Object.entries(state.translationCache).slice(-400);
    localStorage.setItem('ll-translation-cache', JSON.stringify(Object.fromEntries(entries)));
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
  const direction = segment.direction || 'en-zh';
  elements.englishSubtitle.textContent = segment.en || (segment.translating && direction === 'zh-en' ? 'Translating…' : '');
  elements.chineseSubtitle.textContent = segment.zh || (segment.translating && direction === 'en-zh' ? '翻譯中…' : '');
  elements.englishSubtitle.classList.toggle('placeholder', segment.translating && direction === 'zh-en');
  elements.chineseSubtitle.classList.toggle('placeholder', segment.translating && direction === 'en-zh');
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

function persistDraft() {
  if (!state.currentLessonId) return;
  localStorage.setItem('ll-draft', JSON.stringify({ id: state.currentLessonId, durationMs: lessonElapsed(), segments: state.segments }));
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem('ll-draft') || 'null');
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
  } catch (_) {
    localStorage.removeItem('ll-draft');
  }
}

function getLessons() {
  try { return JSON.parse(localStorage.getItem('ll-lessons') || '[]'); } catch (_) { return []; }
}

function renderHistory() {
  const lessons = getLessons();
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
    elements.whisperCompatibility.textContent = detail || '模型只會存在這部裝置，錄音不會上傳。';
    elements.whisperCompatibility.classList.remove('warning');
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
el('historyButton').addEventListener('click', () => { renderHistory(); elements.historyDialog.showModal(); });
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
el('translationToggle').addEventListener('change', (event) => { state.translate = event.target.checked; localStorage.setItem('ll-translate', state.translate); });
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
el('clearHistoryButton').addEventListener('click', () => {
  if (confirm('確定清除所有本機課堂紀錄？')) { localStorage.removeItem('ll-lessons'); renderHistory(); showToast('所有紀錄已清除'); }
});

window.addEventListener('beforeunload', persistDraft);
document.addEventListener('visibilitychange', () => { if (document.hidden) persistDraft(); });

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
whisper?.setTranscriptHandler(handleWhisperTranscript);
whisper?.setStatusHandler(({ status, detail }) => {
  if (status === 'runtime-ready' && state.whisperInstalled) updateWhisperUI('ready');
  else if (['downloading', 'loading-model', 'preparing', 'ready', 'listening', 'transcribing', 'not-installed', 'runtime-error'].includes(status)) updateWhisperUI(status, detail);
});
updateLanguageDirectionUI();
refreshWhisperModelState();
setVisualState('idle');
restoreDraft();
