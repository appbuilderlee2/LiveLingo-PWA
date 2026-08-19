const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const el = (id) => document.getElementById(id);
const elements = {
  app: el('app'), micButton: el('micButton'), micLabel: el('micLabel'), liveStatus: el('liveStatus'),
  statusLabel: el('statusLabel'), elapsedTime: el('elapsedTime'), finishButton: el('finishButton'),
  chineseSubtitle: el('chineseSubtitle'), englishSubtitle: el('englishSubtitle'), interimText: el('interimText'),
  subtitleStage: el('subtitleStage'), transcriptList: el('transcriptList'), transcriptEmpty: el('transcriptEmpty'),
  largeModeButton: el('largeModeButton'), copyButton: el('copyButton'), historyDialog: el('historyDialog'),
  settingsDialog: el('settingsDialog'), lessonDialog: el('lessonDialog'), historyList: el('historyList'), toast: el('toast')
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
  interimTimer: null,
  interimToken: 0,
  lastInterim: '',
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
  recognition.lang = 'en-AU';
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

function punctuate(text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

async function startListening() {
  if (!SpeechRecognition) {
    showToast('此瀏覽器未支援即時語音；請用 iPhone Safari');
    return;
  }
  if (!state.currentLessonId) state.currentLessonId = crypto.randomUUID?.() || String(Date.now());
  if (!state.recognition) state.recognition = createRecognition();
  state.startTime = Date.now();
  state.isListening = true;
  state.isPaused = false;
  state.shouldRestart = true;
  setVisualState('listening');
  startTimer();
  try { state.recognition.start(); }
  catch (_) { showToast('正在重新連接咪高峰…'); }
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
  elements.chineseSubtitle.textContent = '撳下面咪高峰，開始即時字幕';
  elements.englishSubtitle.textContent = 'Tap the microphone to start English recognition.';
  elements.chineseSubtitle.classList.add('placeholder');
  elements.englishSubtitle.classList.add('placeholder');
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
    title: state.segments[0]?.en.slice(0, 48) || 'English lesson',
    segments: state.segments
  };
  const existing = lessons.findIndex((item) => item.id === lesson.id);
  if (existing >= 0) lessons[existing] = lesson; else lessons.unshift(lesson);
  localStorage.setItem('ll-lessons', JSON.stringify(lessons.slice(0, 50)));
  showToast('課堂紀錄已儲存喺本機');
  resetLesson();
}

async function addSegment(rawText) {
  state.interimToken += 1;
  state.lastInterim = '';
  clearTimeout(state.interimTimer);
  const en = punctuate(rawText);
  const duplicate = state.segments.at(-1)?.en === en;
  if (!en || duplicate) return;
  const segment = { id: `${Date.now()}-${state.segments.length}`, atMs: lessonElapsed(), en, zh: '', translating: state.translate };
  state.segments.push(segment);
  renderSegment(segment);
  updateStage(segment);
  persistDraft();
  if (state.translate) {
    segment.zh = await translateText(en);
    segment.translating = false;
    updateSegment(segment);
    updateStage(segment);
    persistDraft();
  } else {
    segment.zh = en;
    segment.translating = false;
    updateSegment(segment);
  }
}

function scheduleInterimTranslation(text) {
  if (!state.translate || text.length < 3 || text === state.lastInterim) return;
  state.lastInterim = text;
  clearTimeout(state.interimTimer);
  const token = ++state.interimToken;
  elements.englishSubtitle.textContent = text;
  elements.englishSubtitle.classList.remove('placeholder');
  elements.chineseSubtitle.textContent = '即時翻譯中…';
  elements.chineseSubtitle.classList.add('placeholder');

  state.interimTimer = setTimeout(async () => {
    const translated = await translateText(text);
    if (token !== state.interimToken || !state.isListening) return;
    elements.chineseSubtitle.textContent = translated;
    elements.chineseSubtitle.classList.remove('placeholder');
  }, 550);
}

async function translateText(text) {
  if (state.translationCache[text]) return state.translationCache[text];
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('translation unavailable');
    const data = await response.json();
    const result = data[0].map((part) => part[0]).join('');
    return cacheTranslation(text, result);
  } catch (_) {
    try {
      const fallbackUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|zh-TW`;
      const fallbackResponse = await fetch(fallbackUrl);
      if (!fallbackResponse.ok) throw new Error('fallback unavailable');
      const fallbackData = await fallbackResponse.json();
      const result = fallbackData.responseData?.translatedText;
      if (!result) throw new Error('empty fallback');
      return cacheTranslation(text, result);
    } catch (_) {
      showToast('翻譯服務暫時連唔到，英文已保存');
      return '（翻譯暫時未能顯示）';
    }
  }
}

function cacheTranslation(text, result) {
    state.translationCache[text] = result;
    const entries = Object.entries(state.translationCache).slice(-400);
    localStorage.setItem('ll-translation-cache', JSON.stringify(Object.fromEntries(entries)));
    return result;
}

function renderSegment(segment) {
  elements.transcriptEmpty.hidden = true;
  const li = document.createElement('li');
  li.className = 'transcript-item';
  li.dataset.id = segment.id;
  li.innerHTML = `<time class="transcript-time">${formatClock(segment.atMs).slice(3)}</time><div class="transcript-copy"><p class="zh translating">翻譯中…</p><p class="en"></p></div>`;
  li.querySelector('.en').textContent = segment.en;
  elements.transcriptList.appendChild(li);
  if (state.autoScroll) li.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function updateSegment(segment) {
  const item = elements.transcriptList.querySelector(`[data-id="${CSS.escape(segment.id)}"]`);
  if (!item) return;
  const zh = item.querySelector('.zh');
  zh.textContent = segment.zh;
  zh.classList.toggle('translating', segment.translating);
}

function updateStage(segment) {
  if (segment !== state.segments.at(-1)) return;
  elements.englishSubtitle.textContent = segment.en;
  elements.englishSubtitle.classList.remove('placeholder');
  elements.chineseSubtitle.textContent = segment.translating ? '翻譯中…' : segment.zh;
  elements.chineseSubtitle.classList.toggle('placeholder', segment.translating);
}

function transcriptText(segments = state.segments) {
  return segments.map((s) => `${formatClock(s.atMs).slice(3)}\n${s.en}\n${s.zh}`).join('\n\n');
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
  elements.lessonDialog.showModal();
}

elements.micButton.addEventListener('click', () => {
  if (state.isListening) pauseListening(); else startListening();
});
elements.finishButton.addEventListener('click', finishLesson);
elements.copyButton.addEventListener('click', () => copyText(transcriptText()));
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
el('autoScrollToggle').addEventListener('change', (event) => { state.autoScroll = event.target.checked; localStorage.setItem('ll-auto-scroll', state.autoScroll); });
el('translationToggle').addEventListener('change', (event) => { state.translate = event.target.checked; localStorage.setItem('ll-translate', state.translate); });
el('clearHistoryButton').addEventListener('click', () => {
  if (confirm('確定清除所有本機課堂紀錄？')) { localStorage.removeItem('ll-lessons'); renderHistory(); showToast('所有紀錄已清除'); }
});

window.addEventListener('beforeunload', persistDraft);
document.addEventListener('visibilitychange', () => { if (document.hidden) persistDraft(); });

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
setVisualState('idle');
restoreDraft();
