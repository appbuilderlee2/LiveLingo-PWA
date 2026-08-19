/* global Module */
(function () {
  'use strict';

  const MODELS = {
    'tiny-en-q5_1': {
      name: 'tiny.en Q5_1', sizeMb: 31, dbKey: 'tiny.en-q5_1',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin'
    },
    'base-en-q5_1': {
      name: 'base.en Q5_1', sizeMb: 57, dbKey: 'base.en-q5_1',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin'
    }
  };
  const DB_NAME = 'livelingo-whisper';
  const DB_VERSION = 1;
  const STORE_NAME = 'models';
  const SAMPLE_RATE = 16000;
  const CHUNK_SECONDS = 5;

  let runtimeReady = false;
  let selectedModel = 'tiny-en-q5_1';
  let loadedModel = null;
  let instance = null;
  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let silentGain = null;
  let pcmChunks = [];
  let pcmLength = 0;
  let pollTimer = null;
  let transcriptHandler = null;
  let statusHandler = null;
  let resolveRuntime;
  const runtimePromise = new Promise((resolve) => { resolveRuntime = resolve; });

  function emitStatus(status, detail = '') {
    statusHandler?.({ status, detail });
  }

  window.Module = {
    print: (...args) => console.debug('[Whisper]', ...args),
    printErr: (...args) => console.warn('[Whisper]', ...args),
    setStatus: (text) => emitStatus('runtime', text),
    monitorRunDependencies: () => {},
    preRun: () => emitStatus('runtime', '正在啟動 Whisper…'),
    postRun: () => {
      runtimeReady = true;
      resolveRuntime();
      emitStatus('runtime-ready');
    }
  };

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getStoredModel(modelKey = selectedModel) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(MODELS[modelKey].dbKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  }

  async function storeModel(buffer, modelKey = selectedModel) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(buffer, MODELS[modelKey].dbKey);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    }).finally(() => db.close());
  }

  function unloadModel() {
    stop();
    if (instance) {
      try { window.Module.free(instance); } catch (_) {}
      instance = null;
    }
    loadedModel = null;
    try { window.Module.FS_unlink('whisper.bin'); } catch (_) {}
  }

  async function deleteModel(modelKey = selectedModel) {
    if (modelKey === loadedModel) unloadModel();
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(MODELS[modelKey].dbKey);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    emitStatus('not-installed');
  }

  async function hasModel(modelKey = selectedModel) {
    try { return Boolean(await getStoredModel(modelKey)); } catch (_) { return false; }
  }

  function storeInWasm(buffer, modelKey = selectedModel) {
    if (loadedModel && loadedModel !== modelKey) unloadModel();
    try { window.Module.FS_unlink('whisper.bin'); } catch (_) {}
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    window.Module.FS_createDataFile('/', 'whisper.bin', bytes, true, true);
    loadedModel = modelKey;
    emitStatus('ready');
  }

  async function ensureModel() {
    await runtimePromise;
    if (loadedModel === selectedModel) return true;
    if (loadedModel) unloadModel();
    const cached = await getStoredModel(selectedModel);
    if (!cached) return false;
    emitStatus('loading-model', '正在載入本機模型…');
    storeInWasm(cached, selectedModel);
    return true;
  }

  async function downloadModel(onProgress) {
    await runtimePromise;
    const modelKey = selectedModel;
    const modelInfo = MODELS[modelKey];
    emitStatus('downloading');
    const response = await fetch(modelInfo.url);
    if (!response.ok || !response.body) throw new Error(`model download failed (${response.status})`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(total ? received / total : 0, received, total);
    }
    const model = new Uint8Array(received);
    let offset = 0;
    chunks.forEach((chunk) => { model.set(chunk, offset); offset += chunk.length; });
    await storeModel(model, modelKey);
    storeInWasm(model, modelKey);
    onProgress?.(1, received, total);
    return true;
  }

  function downsample(input, inputRate) {
    if (inputRate === SAMPLE_RATE) return new Float32Array(input);
    const ratio = inputRate / SAMPLE_RATE;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < output.length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let total = 0;
      for (let j = start; j < end; j += 1) total += input[j];
      output[i] = total / Math.max(1, end - start);
    }
    return output;
  }

  function sendAudio() {
    if (!instance || pcmLength < SAMPLE_RATE * 0.8) return;
    const pcm = new Float32Array(pcmLength);
    let offset = 0;
    pcmChunks.forEach((chunk) => { pcm.set(chunk, offset); offset += chunk.length; });
    pcmChunks = [];
    pcmLength = 0;
    window.Module.set_audio(instance, pcm);
    emitStatus('transcribing');
  }

  async function start() {
    if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
      throw new Error('Whisper 需要重新開啟 App 以啟用安全運算模式');
    }
    const available = await ensureModel();
    if (!available) throw new Error('請先下載 Whisper 模型');
    if (!instance) {
      instance = window.Module.init('whisper.bin', 'en');
      if (!instance) throw new Error('未能啟動 Whisper 模型');
    }
    if (stream) return;

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, autoGainControl: true, noiseSuppression: true },
      video: false
    });
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    await audioContext.resume();
    sourceNode = audioContext.createMediaStreamSource(stream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    processorNode.onaudioprocess = (event) => {
      const chunk = downsample(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
      pcmChunks.push(chunk);
      pcmLength += chunk.length;
      if (pcmLength >= SAMPLE_RATE * CHUNK_SECONDS) sendAudio();
    };
    sourceNode.connect(processorNode);
    processorNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!instance) return;
      const text = window.Module.get_transcribed()?.trim();
      if (text) transcriptHandler?.(text);
      const status = window.Module.get_status?.();
      if (status) emitStatus('engine', status);
    }, 250);
    emitStatus('listening');
  }

  function stop() {
    sendAudio();
    clearInterval(pollTimer);
    pollTimer = null;
    processorNode?.disconnect();
    sourceNode?.disconnect();
    silentGain?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    audioContext?.close().catch(() => {});
    processorNode = null;
    sourceNode = null;
    silentGain = null;
    stream = null;
    audioContext = null;
    pcmChunks = [];
    pcmLength = 0;
    emitStatus(loadedModel ? 'ready' : 'not-installed');
  }

  function setModel(modelKey) {
    if (!MODELS[modelKey]) throw new Error('Unknown Whisper model');
    if (selectedModel !== modelKey && loadedModel && loadedModel !== modelKey) unloadModel();
    selectedModel = modelKey;
  }

  window.LiveLingoWhisper = {
    get runtimeReady() { return runtimeReady; },
    get modelReady() { return loadedModel === selectedModel; },
    get selectedModel() { return selectedModel; },
    get models() { return MODELS; },
    setTranscriptHandler(handler) { transcriptHandler = handler; },
    setStatusHandler(handler) { statusHandler = handler; },
    hasModel,
    ensureModel,
    downloadModel,
    deleteModel,
    setModel,
    start,
    stop
  };
})();
