# Afterglow

Afterglow is a bilingual, local-first focus companion that turns completed work into a glowing city. The ongoing-use product is packaged as installed native apps: Electron on Windows/Linux and Capacitor on Android/iOS. Native working data stays in each app's private local storage. Installed apps can optionally pair without an account and synchronize an end-to-end encrypted copy through a separately deployed Cloudflare Worker backed by SQLite Durable Objects.

The website is now only a browser preview and native-download center. It is deliberately **not** offered as an installable or offline PWA: there is no Web App manifest, Service Worker, browser installation prompt, or offline app shell. Browser storage is best-effort and is not the supported place for durable records.

**Public preview and download center:** https://siriusw823.github.io/afterglow/

**Source repository:** https://github.com/SiriusW823/afterglow

**Current release:** https://github.com/SiriusW823/afterglow/releases/tag/v0.2.0

## Current release status

Version `v0.2.0` is built from the public repository. GitHub Pages exposes only the preview and the same native artifacts attached to the GitHub Release:

| Area | Current fact | Remaining limitation |
| --- | --- | --- |
| Website | GitHub Pages is live at `https://siriusw823.github.io/afterglow/`; its Windows, Linux, and Android buttons resolve only to verified `v0.2.0` Release assets. | It is a browser preview/download center, not a PWA or durable-data product. |
| Encrypted sync | The installed apps use AES-256-GCM, deterministic client-side merge, ETag preconditions, and the production Worker at `afterglow-private-sync.sirius823935.workers.dev`. A two-client create/join/update/delete test and a 3 MiB chunked-envelope round trip pass against the public relay. | This is an independently hosted service, not a formal third-party security audit. Cloudflare can observe IP address, request time, and encrypted payload size. |
| Windows x64 | The unsigned NSIS installer is published as `afterglow-0.2.0-windows-x64.exe`. | It may trigger SmartScreen because it is not code-signed; clean-device installation still needs manual verification. |
| Linux x64 | AppImage and `.deb` packages are published for x64. | Clean-device installation still needs manual verification. |
| Android | A `v0.2.0` debug-signed sideload APK is published for Android 8.0/API 26 or newer. | Clean-device installation still needs manual verification. A stable private signing key is needed for reliable in-place updates. |
| iOS/iPadOS | Capacitor/Xcode source exists; there is no installable iOS artifact. | Build on macOS and complete Apple signing and an appropriate distribution path. |

The Release also includes `afterglow-0.2.0-SHA256SUMS.txt` and a generated `availability.json`; use those published checksums rather than values copied into this document.

## Product principles

- **One thing at a time:** choose a task or write one clear intention before starting.
- **Visible progress:** every completed focus session lights more windows in the city.
- **Native local-first:** installed apps keep working data in app-private local files without requiring an account or sync.
- **Private by design:** there is no analytics system or plaintext user database. The optional sync design uploads an encrypted envelope, not readable tasks or sessions.
- **Portable by choice:** JSON backup/restore and CSV export work independently of sync.
- **Truthful distribution:** the interface only shows a native download after that exact artifact has actually been published.

## Features

- One integrated timer-rhythm card at the top of the Focus screen for Focus, Short Break, and Long Break
- Focus presets of 15, 25, and 50 minutes plus direct custom duration control
- Five-minute duration steps, preventing accidental sequences such as 6, 11, and 16 minutes
- Deadline-based timer recovery after a mobile app is suspended
- Current focus intention, lightweight task list, and post-session reflection
- Daily goal, seven-day chart, consecutive-day streak, best focus hour, and recent history
- Desktop notifications, native Android/iOS completion-notification scheduling, and three completion sounds
- English and Traditional Chinese with a visible language switch
- Versioned JSON backup/restore, CSV export, bounded imports, and a native Filesystem + Share path on mobile
- Keyboard shortcuts, semantic controls, visible focus styles, reduced motion, safe areas, and 44 px touch targets
- Optional account-free end-to-end encrypted synchronization in installed apps, with immediate upload after local changes and a 30-second remote refresh interval

## Timer rhythm and custom minutes

Timer rhythm is part of the main “Ready when you are” panel rather than a separate Settings card. The mode buttons show each saved duration, and the active mode can be edited directly:

| Mode | Allowed range | Step |
| --- | ---: | ---: |
| Focus | 5–180 minutes | 5 minutes |
| Short Break | 5–60 minutes | 5 minutes |
| Long Break | 5–90 minutes | 5 minutes |

Typed values are normalized to the nearest valid five-minute step. The minus/plus controls therefore follow 5, 10, 15, 20, and so on.

## Platform and local-storage model

| Platform | Storage and distribution facts |
| --- | --- |
| Browser preview | Uses IndexedDB with a localStorage compatibility copy while trying the interface. Browsers may evict or clear it. The site is not an installed app, has no offline shell, and is not the durable-data product. |
| Windows/Linux Electron | Uses bounded JSON records under Electron's app-specific `userData` directory. A restricted IPC bridge writes through a temporary file and atomic rename. Uninstalling or manually deleting app data can still remove records. |
| Android/iOS Capacitor | Uses app-private JSON files through Filesystem `Directory.LibraryNoCloud`; mobile exports are written to cache and passed to the system Share sheet. Uninstalling the app can remove its local files. |

Export a JSON backup before clearing browser data, uninstalling an app, replacing a debug-signed APK, or moving to another device. Backup files are readable JSON and do not contain the encrypted-sync root secret, so store them appropriately.

When Android/iOS notification permission is granted, starting or resuming a timer schedules one local notification for the persisted `endAt`. Pausing, resetting, changing mode, restoring data, or clearing data cancels the pending notification. The operating system controls final delivery timing and presentation.

## Browser preview limits

- `public/manifest.webmanifest` and `public/service-worker.js` have been removed.
- The app does not register a Service Worker or handle `beforeinstallprompt`.
- There is no supported browser offline launch or Add-to-Home-Screen installation flow.
- Browser storage can be used to evaluate the interface, but it is not guaranteed durable storage.
- The website is the public preview and download center for the native EXE, Linux packages, and APK.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Start or pause the timer |
| `R` | Reset the current timer |
| `L` | Switch English / 中文 |

Shortcuts do not fire while typing in an input, select, textarea, or button.

## Encrypted sync design

GitHub Pages remains static and never handles synchronization. Installed Electron and Capacitor apps set `SYNC_RELAY_CONFIGURED` to `true` and use the separately deployed HTTPS Worker; the browser preview keeps native sync controls unavailable. The flow is:

1. A device creates a random room identifier and root secret.
2. HKDF-SHA-256 derives separate encryption and opaque locator keys.
3. The client encrypts a canonical snapshot with AES-256-GCM.
4. Only the encrypted binary envelope is sent to the room's SQLite-backed Durable Object.
5. ETag preconditions force concurrent devices to re-read and merge instead of blindly overwriting one another.

The client and Worker both enforce a **4 MiB maximum encrypted envelope**. The Worker hashes the opaque room capability again before selecting a room object. Because one Durable Objects SQLite BLOB is limited to 2 MB, the relay transactionally stores 1 MiB ciphertext chunks and an ETag; it disables caching and never receives the root secret or plaintext app records.

Native transports preserve encrypted bytes without text conversion:

- Electron uses a narrow IPC sync bridge.
- Android/iOS use `CapacitorHttp` with a file/base64 binary adapter, strict base64 validation, a fixed endpoint allowlist, redirects disabled, and bounded timeouts.
- The GitHub Pages browser preview deliberately has no sync transport.

There is no account system and no plaintext cloud database. This does **not** make synchronization cloud-free: Cloudflare Durable Objects hold ciphertext chunks and ordinary storage metadata, while Cloudflare and network providers can observe request time, IP address, and encrypted payload size. Turning sync off leaves the app strictly local-first; JSON backup/restore remains independent of the relay.

Installed apps upload shortly after a local change and also synchronize on launch, reconnect, focus/visibility changes, and every 30 seconds while active. This provides automatic cross-device continuity, but it is accurately described as near-real-time polling rather than a permanent WebSocket connection.

### Data intended to be shared

| Encrypted and merged | Kept separately on each device |
| --- | --- |
| Tasks, completion state, and deletion markers | Running timer, remaining time, deadline, and current round |
| Completed focus sessions, intention, reflection, and rating | Current unsaved focus intention |
| Daily goal and focus/break durations | Finish sound and interface language |
| Data used to recompute charts, streaks, and best focus hour | Notification state, local backups, and local timestamps |

Records merge deterministically by stable ID and update time. Deletion markers prevent an older offline device from immediately restoring deleted data, and accepted generations provide practical rollback detection.

The pairing code contains the only root secret. Anyone who obtains it can decrypt or modify the shared copy. If every paired device and saved pairing code is lost, the server cannot recover the key. End-to-end encryption also cannot protect a compromised device or malicious code running inside the app.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Use the exact localhost URL printed by the development server. This launches the browser preview, not a PWA.

## Native builds

The native renderer is a static Vite build shared by Electron and Capacitor.

| Command | Purpose |
| --- | --- |
| `npm run native:build` | Build the shared renderer into `native-dist/`. |
| `npm run desktop:start` | Launch the already-built renderer in Electron. |
| `npm run desktop:build` | Build for the current desktop platform selected by electron-builder. |
| `npm run desktop:build:win` | Build an unsigned Windows x64 NSIS preview installer. |
| `npm run desktop:build:linux` | Build Linux x64 AppImage and `.deb` artifacts on Linux. |
| `npm run mobile:sync` | Build and sync the renderer, configuration, and plugins into Android and iOS projects. |
| `npm run sync:check` | Dry-run the standalone Durable Objects relay build. |
| `npm run sync:deploy` | Deploy the standalone relay to Cloudflare Workers. |
| `npm run sync:verify` | Run an ephemeral two-client and 3 MiB ciphertext round trip, then delete both test rooms. |
| `npm run android:open` | Sync, then open the Android project in Android Studio. |
| `npm run ios:open` | Sync, then open the iOS project in Xcode on macOS. |

Prerequisites and limits:

- Windows packaging is unsigned and may trigger SmartScreen.
- Linux packaging should run on Linux x64 or in the repository workflow.
- Android targets API 36 and requires Android 8.0/API 26 or newer. The workflow produces a debug-signed sideload APK, not a production-signed Play release. A CI debug certificate may change, so reliable updates require a stable private release-signing key.
- iOS requires macOS, Xcode, an Apple Developer identity/provisioning profile, and a distribution path such as TestFlight or the App Store.

### Publish GitHub Pages and direct downloads

`.github/workflows/native-release.yml` can build Windows, Linux, and Android files. A `vX.Y.Z` tag, or a manual run with the optional `release_tag` input, creates or updates a GitHub Release. A manual run with a blank input only produces 30-day Actions artifacts.

The tag must match `package.json`, and Android `versionName` must match it. A published Release receives stable asset names, a SHA-256 checksum list, and a generated `availability.json`. The Windows download shown on the website and the EXE attached to GitHub Release are the same Release asset, not two untracked copies.

`.github/workflows/pages.yml` builds `native-dist/`, adds the static metadata files, and deploys the artifact through GitHub Pages. On every successful native-release workflow run, it checks whether the matching GitHub Release exists and regenerates `native-dist/downloads/availability.json` with direct EXE, AppImage, and APK links. Until those real files exist, the interface truthfully displays “Installer not available yet.”

The repository is connected at `SiriusW823/afterglow`, Pages uses GitHub Actions as its source, and the native release workflow publishes all four platform files. To publish a future version:

1. Update the package and Android versions together and push `main`.
2. Push the matching `vX.Y.Z` tag or manually run **Native release builds** with that `release_tag`.
3. Verify the EXE, AppImage, `.deb`, APK, checksum file, and regenerated website buttons on clean devices.

For local inspection of the exact metadata that the workflow will generate:

```bash
node scripts/release-metadata.mjs --repository SiriusW823/afterglow --tag v0.2.0 --output native-dist/downloads/availability.json
```

`node scripts/release-metadata.mjs --check` validates the shared package/Android version and rejects a mismatched release tag.

## Validate

```bash
npm run lint
npm test
npm run build
npm run pages:build
```

The automated suite covers the non-PWA browser-preview contract, GitHub Pages paths, native-only production relay configuration, timer recovery, five-minute duration steps, timer-rhythm placement, translations, statistics, native storage/export contracts, scheduled native notifications, Android API 26, CapacitorHttp binary transport, encrypted pairing and AES-GCM envelopes, deterministic merge behavior, 4 MiB relay limits, conditional relay writes, and release metadata. The production relay additionally passes a real two-client merge and 3 MiB chunked ciphertext round trip. Clean-device installation, iOS distribution, a formal security audit, and signed desktop/Android distribution still require external verification.

## Project structure

- `app/page.tsx` — timer rhythm, tasks, insights, browser-preview/download status, local controls, and interactions
- `app/i18n.ts` — English and Traditional Chinese copy
- `app/lib/local-store.ts` — native records plus best-effort IndexedDB/localStorage browser-preview persistence
- `app/lib/native-runtime.ts` — Electron storage/IPC, Capacitor Filesystem/Share, notifications, and native binary sync adapters
- `app/lib/private-sync.ts` — pairing codes, key derivation, AES-GCM envelopes, merge, rollback checks, and the 4 MiB client limit
- `worker/sync-relay.ts` — standalone SQLite Durable Objects ciphertext relay with transactional 1 MiB chunks
- `worker/private-sync.ts` — authorization, 4 MiB request bounds, ETag preconditions, and no-store response policy
- `desktop/` — sandboxed Electron main process and narrow preload bridge
- `android/` and `ios/` — Capacitor native source projects
- `native/` and `vite.native.config.ts` — shared static native renderer entry and build configuration
- `.github/workflows/pages.yml` — static GitHub Pages build and deployment
- `scripts/release-metadata.mjs` — release-version validation, stable asset names, and GitHub download metadata
- `public/` — icons, social preview, and native artifact availability metadata; no PWA manifest or Service Worker
- `tests/` — product, timer, statistics, native-runtime, encrypted-sync, Worker, and release tests
- `submission/` — submission copy, demo script, shot list, development log, and demo media

## License

[MIT](LICENSE)
