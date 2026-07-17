# Development log template

Use this alongside Hackatime. Record only work you personally completed and can support with a file, test, commit, screenshot, or video.

| Date | Hackatime duration | Work completed | Proof / commit |
| --- | ---: | --- | --- |
| YYYY-MM-DD | 0h 00m | Example: moved Timer rhythm into the main card and tested 5-minute normalization | commit URL |

## Suggested categories

- Product research, HIG-inspired visual hierarchy, and interface planning
- Timer, tasks, skyline, and deadline-based recovery
- Integrated Focus／Short Break／Long Break rhythm controls
- Five-minute duration normalization and boundary tests
- Weekly statistics, streak, best-hour logic, and reflections
- Browser-preview/download-center positioning and removal of unsupported PWA/offline claims
- Electron sandbox, restricted IPC, atomic `userData` storage, and Windows preview packaging
- Capacitor Android/iOS source, `LibraryNoCloud` JSON storage, Filesystem/Share export, and safe-area work
- Android API 26 minimum, target API 36, Gradle permissions, and debug APK packaging
- `CapacitorHttp` file/base64 binary adapter and encrypted-byte validation
- Native completion-notification scheduling and cancellation against persisted `endAt`
- English／Traditional Chinese localization and terminology review
- Accessibility, keyboard interactions, reduced motion, and focus management
- Browser-preview IndexedDB compatibility, import validation, JSON backup, and CSV export
- End-to-end encrypted pairing, deterministic merge, rollback handling, 4 MiB limits, and threat modeling
- Sites relay access investigation and public two-device verification—record deployment as complete only after signed-out/native testing passes
- GitHub Actions packaging, stable artifact names, release checksums, and manifest generation—record a Release only after it really exists
- Testing, debugging, documentation, screenshots, and demo production

## Evidence guardrails

- Do not log PWA manifest, Service Worker, offline app-shell, or Web App installation work as a current feature; those paths were removed.
- Building an unsigned Windows x64 NSIS preview is not the same as signing or publishing a Windows release.
- A Linux `.deb`/AppImage or Android debug-signed APK is “published” only after the exact artifact can be downloaded from the public Release.
- Android debug signing is not a stable production update key. Document API 26+ and the signing limitation.
- Sync crypto and relay code can be logged as implemented/tested, but “public sync released” requires a separately hosted relay and a successful unauthenticated two-device test. The current release deliberately leaves the relay unconfigured.
- iOS source work is not an iOS release; Xcode compilation, Apple signing, and distribution require separate work on macOS.
- Manually added Afterglow sessions are product data, not proof of Hackatime development hours.
