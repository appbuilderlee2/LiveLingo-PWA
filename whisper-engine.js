/* global Module */
(function () {
  'use strict';

  const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin';
  const DB_NAME = 'livelingo-whisper';
  const DB_VERSION = 1;
  const STORE_NAME = 'models';
  const MODEL_KEY = 'tiny.en-q5_1';
  const SAMPLE_RATE = 16000;
  const CHUNK_SECONDS = 5;

  let runtimeReady = false;
  let modelReady = false;
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

  async function getStoredModel() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(MODEL_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  }

  async function storeModel(buffer) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(buffer, MODEL_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    }).finally(() => db.close());
  }

  async function deleteModel() {
    stop();
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(MODEL_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    modelReady = false;
    try { window.Module.FS_unlink('whisper.bin'); } catch (_) {}
    emitStatus('not-installed');
  }

  async function hasModel() {
    try { return Boolean(await getStoredModel()); } catch (_) { return false; }
  }

  function storeInWasm(buffer) {
    try { window.Module.FS_unlink('whisper.bin'); } catch (_) {}
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    window.Module.FS_createDataFile('/', 'whisper.bin', bytes, true, true);
    modelReady = true;
    emitStatus('ready');
  }

  async function ensureModel() {
    await runtimePromise;
    if (modelReady) return true;
    const cached = await getStoredModel();
    if (!cached) return false;
    emitStatus('loading-model', '正在載入本機模型…');
    storeInWasm(cached);
    return true;
  }

  async function downloadModel(onProgress) {
    await runtimePromise;
    emitStatus('downloading');
    const response = await fetch(MODEL_URL);
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
    await storeModel(model);
    storeInWasm(model);
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
    emitStatus(modelReady ? 'ready' : 'not-installed');
  }

  window.LiveLingoWhisper = {
    get runtimeReady() { return runtimeReady; },
    get modelReady() { return modelReady; },
    setTranscriptHandler(handler) { transcriptHandler = handler; },
    setStatusHandler(handler) { statusHandler = handler; },
    hasModel,
    ensureModel,
    downloadModel,
    deleteModel,
    start,
    stop
  };
})();
