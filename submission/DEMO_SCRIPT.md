# 60-second demo script

## Voiceover

> This is Afterglow, a bilingual local-first focus companion that makes completed work visible. Timer rhythm now lives directly in the main focus card: I can switch between focus, short break, and long break, then choose time in clear five-minute steps. I select one intention, start the deadline-based timer, and every completed session lights more windows in my city. Afterward I can add a reflection and review my seven-day chart, streak, and best focus hour. The installed Electron and Capacitor apps keep working data in app-private local files, with JSON backup and mobile Share export. The GitHub Pages website is a browser preview and native-download center, not an installable or offline PWA. End-to-end encrypted sync code has been implemented, but this release has no relay configured, so I use JSON backup between devices and do not claim sync is available. Afterglow turns focused time into something calm, visible, and honest about where data lives.

## Recording notes

- Record at 1920×1080 or 1280×720 with browser zoom at 100%.
- The minimum duration is 5 minutes. Show 5 → 10 → 15 with the controls; do not demonstrate a 1-minute option that no longer exists.
- Use “Add earlier session” to demonstrate a city change without waiting five minutes.
- Do not claim manually logged Afterglow minutes increase Hackatime hours.
- Show that Timer rhythm is inside the top focus card, not duplicated in Settings.
- Show the visible English／繁體中文 switch and both desktop and phone layouts.
- Do not call the website a PWA, installable Web App, or offline app. It is a browser preview/download center.
- Record the final GitHub Pages URL shot only after a signed-out browser can open it; use localhost for a draft recording.
- Do not show a download button unless that exact GitHub Release artifact exists. At present no Release has been published because the checkout has no remote and `gh` authentication is invalid.
- When artifacts exist, label Windows/Linux as x64, Windows as unsigned, and Android as a debug-signed sideload APK requiring Android 8.0/API 26 or newer. Do not imply stable Android updates or an iOS direct download.
- Do not demonstrate encrypted sync as a working public feature while no relay is configured. Show JSON backup/export instead and describe sync only as implemented pre-release architecture.
- If sync is later demonstrated, use a temporary pairing code, never expose a long-lived code, and delete the test room afterward.
- Do not say “completely cloud-free”: a working optional sync relay stores E2EE ciphertext plus normal operational metadata. Leave sync off for a strictly local demonstration.
- When demonstrating a mobile background notification, state that Afterglow schedules it for `endAt` but the operating system controls delivery.
