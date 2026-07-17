# Demo shot list

| Time | Shot | Action / on-screen result |
| --- | --- | --- |
| 0:00–0:06 | Hero city | Show the full Afterglow desk view and title |
| 0:06–0:14 | Timer rhythm | In the top focus card, switch Focus → Short Break → Long Break; show that 5-minute controls move 5 → 10 → 15 |
| 0:14–0:22 | One intention | Select a task, start/pause with Space, then use “Add earlier session” to illuminate more windows |
| 0:22–0:30 | Reflection and insights | Add a quick reflection; show the seven-day chart, daily goal, streak, and best focus hour |
| 0:30–0:37 | Mobile layout | Switch to phone size; show bottom navigation, safe spacing, and the separate Settings entry |
| 0:37–0:44 | Bilingual | Switch between Traditional Chinese and English with the visible language control |
| 0:44–0:51 | Native downloads | Show the website as a browser preview/download center—not a PWA. Only show a download link after the exact GitHub Release asset exists; otherwise show the honest unavailable status |
| 0:51–0:58 | Local data and privacy | Show JSON backup or native encrypted-sync pairing. State that working data is app-private and the optional relay receives only ciphertext |
| 0:58–1:00 | End card | Show Afterglow and “Make your work leave a light on.” Add the live URL only after it works in a signed-out browser |

## Accuracy checks before recording

- Do not include PWA installation, Add to Home Screen, Service Worker, or offline-launch footage; those features were removed.
- If demonstrating sync, use a temporary pairing code and delete the room after recording; do not expose a long-lived root secret.
- Do not show guessed GitHub URLs or an artifact that is not present in the public Release.
- When an Android artifact exists, label it debug-signed, API 26+, and not production-signed for reliable updates.
