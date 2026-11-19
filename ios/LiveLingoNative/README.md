# LiveLingo Native — iOS prototype

This is an **experimental native SwiftUI app**, separate from the existing PWA.

- Main screen prioritizes original transcript, translation, and newest-first history.
- On-device speech recognition uses Apple Speech with `requiresOnDeviceRecognition = true`. Recognition availability varies by language/device.
- Translation uses Apple's Translation framework. Language downloads and OS support are required; test on iPhone.
- History is stored locally in UserDefaults.
- **Native whisper.cpp is not yet integrated.** This prototype is not a production replacement for the PWA.
- No backend. No API key.

## Build
1. Install Xcode and XcodeGen on a Mac.
2. `cd ios/LiveLingoNative && xcodegen generate`
3. Open `LiveLingoNative.xcodeproj`, select an Apple signing team and build to a device.
4. GitHub Actions can generate an **unsigned** IPA artifact. SideStore/AltStore must sign it with a compatible certificate before installation.

## Limitations
- First translation may prompt for language pack download.
- Translation is currently English → Traditional Chinese; language direction settings and native whisper.cpp model downloads are future work.
- Live recognition may produce a long segment before finalization; segmentation needs real-device tuning.
- Build and runtime are not yet verified on physical hardware.
