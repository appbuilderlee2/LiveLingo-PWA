# LiveLingo PWA

Mobile-first English speech recognition with Traditional Chinese live subtitles.

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
- Translation uses the public Google Translate web endpoint and therefore needs an internet connection.
- Audio is never written by this app. Transcripts and lesson history are kept in browser local storage.
- iPhone users should open the deployed HTTPS site in Safari and choose Share → Add to Home Screen.
