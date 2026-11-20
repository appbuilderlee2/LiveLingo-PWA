# LiveLingo Native — iOS prototype

This is an **experimental native SwiftUI app**, separate from the existing PWA.

- Main screen prioritizes original transcript, translation, and newest-first history.
- On-device speech recognition uses Apple Speech with `requiresOnDeviceRecognition = true`. Recognition availability varies by language/device.
- Translation uses Apple's Translation framework. Language downloads and OS support are required; test on iPhone.
- History is stored locally in UserDefaults.
- Native Whisper integration uses **WhisperKit / Core ML**, not whisper.cpp. It downloads the tiny model on first use and transcribes local ~8-second microphone chunks. This is a first implementation, not yet verified on hardware.
- No backend. No API key.

## Build
1. Install Xcode and XcodeGen on a Mac.
2. `cd ios/LiveLingoNative && xcodegen generate`
3. Open `LiveLingoNative.xcodeproj`, select an Apple signing team and build to a device.
4. GitHub Actions can generate an **unsigned** IPA artifact. SideStore/AltStore must sign it with a compatible certificate before installation.

## Limitations
- First translation may prompt for language pack download.
- Translation is currently English → Traditional Chinese; bidirectional language settings and selectable Whisper models are future work.
- Live recognition may produce a long segment before finalization; segmentation needs real-device tuning.
- Build and runtime are not yet verified on physical hardware. GitHub Actions may require fixes after the first actual build.

## CI
Pushing changes under this iOS directory automatically triggers the unsigned iOS IPA build workflow on GitHub Actions.
