# LiveLingo PWA

Current app version: **v1.8.0**

Mobile-first English speech recognition with Traditional Chinese live subtitles.

Supports bidirectional live translation: English speech to Traditional Chinese, and Chinese speech to English. English-only Whisper models remain available for the English-to-Chinese direction; Chinese-to-English uses the browser Web Speech engine.

Interim speech is translated after a short debounce, so Traditional Chinese appears before the browser finalizes each English sentence.

Current and saved lessons can be exported as timestamped UTF-8 text files through the iOS share sheet or a browser download fallback.

Lessons can also be rendered as a print-ready A4 document. On iPhone, use the print preview share action to save the result as a PDF file.

## Run locally

Serve this directory over HTTPS (required for microphone access), or use localhost during development:

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Notes

- Speech recognition uses the browser Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`).
- Recognition modes include Web Speech, Web Speech with local Whisper correction, and local Whisper-only recognition.
- Whisper loads the official whisper.cpp WebAssembly stream runtime. Users can download `tiny.en Q5_1` (about 31 MB, faster) or `base.en Q5_1` (about 57 MB, more accurate) on demand. The audio capture path now prefers `AudioWorklet` for better long-session stability, with `ScriptProcessor` retained only as a compatibility fallback. The service worker caches the runtime and IndexedDB stores each model separately for later offline use.
- Translation uses the public Google Translate web endpoint and therefore needs an internet connection.
- Audio is never written by this app. Transcripts and lesson history are kept in browser local storage.
- iPhone users should open the deployed HTTPS site in Safari and choose Share → Add to Home Screen.

The whisper.cpp WebAssembly runtime is provided by the official project under its MIT License.


## v1.8.0 PWA engine improvements

- Audio capture prefers AudioWorklet to reduce main-thread microphone processing pressure during long lessons.
- Service worker caching is request-aware: navigations use network-first, app assets use stale-while-revalidate, and the Whisper runtime uses cache-first.
- Failed JS/CSS requests no longer fall back to `index.html`, preventing MIME and `Unexpected token '<'` failures.
- Translation requests now have timeouts and automatic fallback instead of waiting indefinitely on a stalled endpoint.
- Translation cache writes are debounced to reduce synchronous localStorage work while live captions are running.
