# LiveLingo PWA

Current app version: **v2.5.2**

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
- Whisper loads the official whisper.cpp WebAssembly stream runtime. Users can download `tiny.en Q5_1` (about 31 MiB, fastest), `base.en Q5_1` (about 57 MiB, balanced), or `small.en Q5_1` (about 181 MiB, higher accuracy) on demand. The audio capture path now prefers `AudioWorklet` for better long-session stability, with `ScriptProcessor` retained only as a compatibility fallback. The service worker caches the runtime and IndexedDB stores each model separately for later offline use.
- Translation uses the public Google Translate web endpoint and therefore needs an internet connection.
- Audio is never written by this app. Lesson history and unfinished drafts are stored asynchronously in IndexedDB; small preferences remain in local storage.
- iPhone users should open the deployed HTTPS site in Safari and choose Share → Add to Home Screen.

The whisper.cpp WebAssembly runtime is provided by the official project under its MIT License.


## v1.8.0 PWA engine improvements

- Audio capture prefers AudioWorklet to reduce main-thread microphone processing pressure during long lessons.
- Service worker caching is request-aware: navigations use network-first, app assets use stale-while-revalidate, and the Whisper runtime uses cache-first.
- Failed JS/CSS requests no longer fall back to `index.html`, preventing MIME and `Unexpected token '<'` failures.
- Translation requests now have timeouts and automatic fallback instead of waiting indefinitely on a stalled endpoint.
- Translation cache writes are debounced to reduce synchronous localStorage work while live captions are running.


## v1.9.0 caption quality improvements

- Smart Whisper correction now aligns the Whisper transcript against the best matching recent Web Speech segment window instead of blindly replacing every recent segment.
- Low-confidence Whisper matches are preserved as separate segments rather than deleting potentially correct live captions.
- The matcher can safely merge one to three nearby Web Speech segments when Whisper returns a longer corrected phrase.
- Draft lesson persistence is debounced during live captioning to reduce synchronous localStorage writes, while backgrounding or closing the app still forces an immediate save.


## v2.0.0 long-session reliability

- Lesson history and unfinished drafts moved from synchronous localStorage to IndexedDB, reducing main-thread work and avoiding small localStorage quotas during long classes.
- Existing v1.x lesson history and unfinished drafts migrate automatically on first launch after the update.
- Lesson history remains capped at the newest 50 lessons.
- Repeated Whisper poll results are suppressed for a short window so stale engine output does not create duplicate captions or repeated smart corrections.
- Identical translation requests now share one in-flight network request instead of sending duplicates.
- Draft writes remain debounced and use asynchronous IndexedDB storage; backgrounding the PWA triggers an immediate save attempt.


## v2.1.0 Small Whisper model

- Adds the official whisper.cpp `small.en Q5_1` model as an optional high-accuracy English model.
- Keeps Tiny and Base available for lower latency and lower memory use.
- Small is about 181 MiB and is not selected automatically.
- The app shows a higher-resource warning when Small is selected.
- Before downloading a model, the PWA checks estimated browser storage and asks for roughly 25% headroom.
- Large-model downloads use a longer timeout to reduce failures on slower connections.


## v2.2.0 Whisper chunk continuity

- Adds a 1-second rolling audio overlap between 5-second Whisper chunks to reduce word loss at chunk boundaries.
- Keeps the overlap in memory only; audio is still not written to storage.
- Suppresses identical Whisper engine poll output before it reaches the caption pipeline.
- Offline Whisper captions remove repeated leading words introduced by the rolling overlap, using up to a 10-word suffix/prefix match.
- Smart-correction mode continues to use the full overlapped Whisper transcript for alignment against recent Web Speech segments.


## v2.3.0 adaptive live translation

- Replaces the fixed 550 ms interim-translation delay with an adaptive scheduler.
- Very short phrases can begin translating after about 260 ms, while longer unfinished sentences wait slightly longer for better context.
- Sentence-ending punctuation can trigger translation in about 180 ms.
- Interim translation requests are throttled to at least 450 ms apart to reduce unnecessary network traffic during continuous speech.
- Tiny transcript extensions wait a little longer instead of repeatedly translating almost identical text.
- The last completed Chinese subtitle remains visible while the next interim translation is pending, reducing subtitle flicker.


## v2.4.0 caption reading experience

- Separates the current live caption area from the completed transcript with clear visual labels.
- Shows a compact live state such as “正在講”, “最新字幕”, or “已暫停”.
- Replaces duplicated interim English text with a lightweight recognition status, reducing visual clutter.
- Caption text only updates when the visible content actually changes.
- Adds a subtle short transition for changed caption text instead of abrupt full-line flashes.
- Keeps completed transcript rows visually stable under a sticky “已完成字幕” heading.


## v2.5.0 long-caption buffer

- Keeps the previous completed sentence visible above the current live caption so the latest two thoughts remain readable.
- During an interim utterance, the previous panel shows the most recent completed sentence; after finalization it shows the sentence before the newest one.
- Long Chinese and English captions automatically step down through several font-size tiers instead of forcing large layout jumps.
- Uses natural browser line wrapping with `text-wrap: pretty` and safer word breaking for long classroom terminology.
- Large-caption mode also keeps the previous sentence and applies separate scaling tiers for long text.


## v2.5.1 translation reliability

- Allows up to 15 seconds for slow Google and MyMemory translation responses instead of failing after 6.5 seconds.
- Cancels obsolete interim translation requests whenever the live transcript changes, preventing a long lesson from building up a large network backlog.
- A temporary provider failure no longer replaces readable captions with a failure message; the recognized source sentence remains saved and visible.


## v2.5.2 translation endpoint recovery

- Uses Google's browser-compatible `clients5.google.com` translation endpoint as the primary provider after the previous endpoint began returning HTTP 500 responses.
- Keeps the previous Google endpoint and MyMemory as ordered fallbacks.
- Logs the failing provider and error in the browser console while preserving recognized source captions in the interface.
