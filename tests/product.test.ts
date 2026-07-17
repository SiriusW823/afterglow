import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { translations } from "../app/i18n.ts";

test("English and Chinese contain the same translation keys", () => {
  assert.deepEqual(Object.keys(translations.en).sort(), Object.keys(translations.zh).sort());
});

test("English remains available from a visible header language switch", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<header className="topbar">[\s\S]*?className="language-chip"[\s\S]*?<\/header>/);
  assert.match(page, /setLanguage\(language === "en" \? "zh" : "en"\)/);
  assert.match(page, /aria-label=\{tr\("switchLanguage"\)\}/);
  assert.equal(typeof translations.en.headline, "string");
  assert.ok(translations.en.headline.length > 0);
});

test("legacy snapshots without a language follow the device instead of forcing Chinese", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /language\?: Language/);
  assert.match(page, /raw\.language === "en" \|\| raw\.language === "zh" \? raw\.language : undefined/);
  assert.match(page, /const detectedLanguage: Language = navigator\.language\.toLowerCase\(\)\.startsWith\("zh"\) \? "zh" : "en"/);
  assert.match(page, /setLanguage\(data\.language \?\? detectedLanguage\)/);
  assert.doesNotMatch(page, /raw\.language === "en" \? "en" : "zh"/);
});

test("browser preview is not offered as an installable or offline PWA", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  await assert.rejects(readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"), { code: "ENOENT" });
  assert.doesNotMatch(layout, /manifest:\s*"\/manifest\.webmanifest"|appleWebApp/);
  assert.doesNotMatch(page, /beforeinstallprompt|appinstalled|serviceWorker\.register/);
  assert.match(page, /serviceWorker\.getRegistrations\(\)/);
  assert.match(page, /browserPreviewTitle/);
  assert.match(translations.en.browserPreviewCopy, /not offered as an installable or offline Web App/i);
  assert.match(translations.zh.browserPreviewCopy, /不再提供可安裝或離線使用的 Web App/);
});

test("product is account-free and local-first while an unconfigured relay stays disabled", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const localStore = await readFile(new URL("../app/lib/local-store.ts", import.meta.url), "utf8");
  const privateSync = await readFile(new URL("../app/lib/private-sync.ts", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../app/lib/native-runtime.ts", import.meta.url), "utf8");
  await assert.rejects(readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"), { code: "ENOENT" });
  assert.doesNotMatch(page, /signin-with-chatgpt|signout-with-chatgpt/);
  assert.match(runtime, /SYNC_RELAY_CONFIGURED = false/);
  assert.match(page, /if \(!SYNC_RELAY_CONFIGURED \|\| !hydrated \|\| !syncRoomId\) return/);
  assert.match(page, /syncNotPublishedTitle/);
  assert.match(localStore, /indexedDB\.open/);
  assert.match(localStore, /__afterglowSyncRecord/);
  assert.match(localStore, /expectedIdentity/);
  assert.match(localStore, /requireEmpty/);
  assert.match(localStore, /deleted: boolean/);
  assert.match(localStore, /SYNC_LOCK_KEY/);
  assert.match(localStore, /navigator\.locks/);
  assert.match(localStore, /withIndexedDbSyncLock/);
  assert.match(localStore, /fallbackRealmQueue/);
  assert.match(localStore, /await previousHolder/);
  assert.match(localStore, /activeFallbackLockToken/);
  assert.match(localStore, /assertLocalSyncLockOwnership/);
  assert.match(localStore, /lock\?\.token === fenceToken/);
  assert.match(localStore, /if \(indexed\)[\s\S]*localStorage\.removeItem\(SYNC_FALLBACK_KEY\)[\s\S]*else \{[\s\S]*fallback = legacy/);
  assert.match(localStore, /clearLocalSyncConfig\(expectedIdentity/);
  assert.match(localStore, /__afterglowSnapshotRecord/);
  assert.match(page, /withLocalSyncLock/);
  assert.match(page, /assertLocalSyncLockOwnership/);
  assert.match(page, /clearLocalSyncConfig\(previousConfig\)/);
  assert.match(page, /clearLocalSyncConfig\(config\)/);
  assert.match(page, /storageWriteFailed/);
  assert.match(privateSync, /AES-GCM/);
  assert.match(privateSync, /HKDF/);
  assert.match(privateSync, /If-Match/);
  assert.match(privateSync, /requireExisting/);
});

test("install experience points to real native artifacts instead of a PWA prompt", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /new URL\("downloads\/availability\.json", document\.baseURI\)/);
  assert.match(translations.en.downloadAppsCopy, /GitHub Releases/);
  assert.match(translations.zh.downloadAppsCopy, /GitHub Releases/);
  assert.doesNotMatch(page, /installGuideOpen|installPrompt|installApp/);
});

test("desktop shell is sandboxed and exposes only storage plus encrypted-sync IPC", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const preload = await readFile(new URL("../desktop/preload.mjs", import.meta.url), "utf8");
  assert.match(main, /app\.enableSandbox\(\)/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /webSecurity: true/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /will-navigate[\s\S]*event\.preventDefault\(\)/);
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("afterglowDesktop"/);
  const invokedChannels = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(invokedChannels, [
    "afterglow:storage:read",
    "afterglow:storage:remove",
    "afterglow:storage:write",
    "afterglow:sync:fetch",
  ]);
  assert.doesNotMatch(preload, /shell|webFrame|remote|sendSync|ipcRenderer\.send\(/);
});

test("Capacitor uses no-cloud files, Share exports, and an explicit binary HTTP adapter", async () => {
  const config = await readFile(new URL("../capacitor.config.ts", import.meta.url), "utf8");
  const androidVariables = await readFile(new URL("../android/variables.gradle", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../app/lib/native-runtime.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(config, /webDir: "native-dist"/);
  assert.doesNotMatch(config, /CapacitorHttp:[\s\S]*enabled: true/);
  assert.match(androidVariables, /minSdkVersion = 26/);
  assert.match(runtime, /import \{ Directory, Encoding, Filesystem \} from "@capacitor\/filesystem"/);
  assert.match(runtime, /import \{ Share \} from "@capacitor\/share"/);
  assert.match(runtime, /Capacitor\.isNativePlatform\(\)/);
  assert.match(runtime, /readNativeValue<T>[\s\S]*Filesystem\.readFile\([\s\S]*Directory\.LibraryNoCloud/);
  assert.match(runtime, /writeNativeValue[\s\S]*Filesystem\.writeFile\([\s\S]*Directory\.LibraryNoCloud/);
  assert.match(runtime, /removeNativeValue[\s\S]*Filesystem\.deleteFile\([\s\S]*Directory\.LibraryNoCloud/);
  assert.match(runtime, /exportNativeFile[\s\S]*Directory\.Cache[\s\S]*Share\.share\(/);
  assert.match(runtime, /CapacitorHttp/);
  assert.match(runtime, /capacitorSyncFetch[\s\S]*dataType: "file"[\s\S]*responseType: "arraybuffer"[\s\S]*disableRedirects: true/);
  assert.match(runtime, /if \(isMobileNativeApp\(\)\) return capacitorSyncFetch/);
  assert.doesNotMatch(runtime, /@capacitor\/preferences|Preferences\./);
  assert.equal(typeof packageJson.dependencies["@capacitor/filesystem"], "string");
  assert.equal(typeof packageJson.dependencies["@capacitor/share"], "string");
  assert.equal(packageJson.dependencies["@capacitor/preferences"], undefined);
  assert.match(page, /if \(!await exportNativeFile\(filename, contents\)\) downloadFile\(filename, contents, "application\/json"\)/);
  assert.match(page, /if \(!await exportNativeFile\(filename, contents\)\) downloadFile\(filename, contents, "text\/csv;charset=utf-8"\)/);
  assert.match(page, /setNotice\(tr\("exportFailed"\)\)/);
});

test("mobile completion notifications are scheduled for endAt and canceled with timer state", async () => {
  const runtime = await readFile(new URL("../app/lib/native-runtime.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(runtime, /scheduleNativeCompletionNotification[\s\S]*LocalNotifications\.cancel\([\s\S]*LocalNotifications\.schedule\([\s\S]*new Date\(Math\.max\(at, Date\.now\(\) \+ 100\)\)/);
  assert.match(runtime, /cancelNativeCompletionNotification[\s\S]*LocalNotifications\.cancel\(/);
  assert.match(page, /if \(!hydrated \|\| endAt === null \|\| endAt <= Date\.now\(\)\) return;[\s\S]*scheduleNativeCompletionNotification\([\s\S]*endAt/);
  assert.ok((page.match(/cancelNativeCompletionNotification\(\)/g) ?? []).length >= 4);
  assert.match(page, /const storedSecondsLeft = endAt === null \? secondsLeft : plannedMinutes \* 60/);
  assert.match(page, /timer: \{ mode, secondsLeft: storedSecondsLeft, endAt, plannedMinutes, startedAt \}/);
});

test("iOS source normalizes generated package paths and includes its privacy manifest", async () => {
  const packageSwift = await readFile(new URL("../ios/App/CapApp-SPM/Package.swift", import.meta.url), "utf8");
  const fixer = await readFile(new URL("../scripts/fix-capacitor-generated.mjs", import.meta.url), "utf8");
  const privacy = await readFile(new URL("../ios/App/App/PrivacyInfo.xcprivacy", import.meta.url), "utf8");
  const project = await readFile(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8");
  const pathValues = [...packageSwift.matchAll(/\.package\([^\n]*path: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(pathValues.length > 0);
  assert.ok(pathValues.every((value) => value.includes("/") && !value.includes("\\")));
  assert.match(fixer, /value\.replaceAll\("\\\\", "\/"\)/);
  assert.match(fixer, /invalid Swift package path/);
  assert.match(privacy, /NSPrivacyAccessedAPICategoryFileTimestamp/);
  assert.match(privacy, /C617\.1/);
  assert.match(project, /PrivacyInfo\.xcprivacy in Resources/);
});

test("installed apps route snapshots and sync configuration through native storage", async () => {
  const localStore = await readFile(new URL("../app/lib/local-store.ts", import.meta.url), "utf8");
  assert.match(localStore, /import \{ isNativeApp, readNativeValue, writeNativeValue \} from "\.\/native-runtime"/);
  assert.match(localStore, /readLocalSnapshot<T>[\s\S]*if \(isNativeApp\(\)\)[\s\S]*readNativeValue\(NATIVE_SNAPSHOT_KEY\)/);
  assert.match(localStore, /persistSnapshot[\s\S]*if \(isNativeApp\(\)\)[\s\S]*writeNativeValue\(NATIVE_SNAPSHOT_KEY, record\)/);
  assert.match(localStore, /readLocalSyncConfig<T>[\s\S]*if \(isNativeApp\(\)\)[\s\S]*readNativeValue\(NATIVE_SYNC_CONFIG_KEY\)/);
  assert.match(localStore, /persistSyncState[\s\S]*if \(isNativeApp\(\)\)[\s\S]*writeNativeValue\(NATIVE_SYNC_CONFIG_KEY, record\)/);
});

test("native download links require an available artifact and iOS has no direct download", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../public/downloads/availability.json", import.meta.url), "utf8")) as {
    version: number;
    builds: Record<string, { href: string }>;
  };
  assert.equal(manifest.version, 1);
  assert.match(page, /new URL\("downloads\/availability\.json", document\.baseURI\)/);
  assert.match(page, /const build = downloadBuilds\[option\.id\]/);
  assert.match(page, /\{build \? <a className="download-link" href=\{build\.href\} download>[\s\S]*?: <span className="build-unavailable">/);
  assert.match(page, /for \(const target of \["windows", "linux", "android"\] as const\)/);
  assert.match(page, /<strong>\{tr\("iosApp"\)\}<\/strong>[\s\S]*?<span className="build-unavailable">/);
  assert.doesNotMatch(page, /id: "ios"[\s\S]{0,120}href/);
  assert.match(translations.en.iosDetail, /not currently offered/i);
  assert.match(translations.zh.iosDetail, /目前不提供/);

  for (const [target, build] of Object.entries(manifest.builds)) {
    assert.ok(["windows", "linux", "android"].includes(target));
    if (build.href.startsWith("/downloads/")) {
      assert.match(build.href, /^\/downloads\/[a-z0-9._-]+$/i);
      await readFile(new URL(`../public${build.href}`, import.meta.url));
    } else {
      const url = new URL(build.href);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username, "");
      assert.equal(url.password, "");
    }
  }
});

test("native release automation builds three platforms without an iOS or release keystore secret", async () => {
  const workflow = await readFile(new URL("../.github/workflows/native-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags:[\s\S]*- "v\*"/);
  assert.match(workflow, /npm run desktop:build:win/);
  assert.match(workflow, /npm run desktop:build:linux/);
  assert.match(workflow, /assembleDebug/);
  assert.match(workflow, /chmod \+x gradlew && \.\/gradlew assembleDebug/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /gh release upload/);
  assert.doesNotMatch(workflow, /ios:open|xcodebuild|keystore|storeFile|SIGNING_KEY|secrets\./i);
});

test("GitHub Pages publishes the static renderer and injects verified Release links", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const preparer = await readFile(new URL("../scripts/prepare-pages.mjs", import.meta.url), "utf8");
  assert.equal(packageJson.scripts["pages:build"], "npm run native:build && node scripts/prepare-pages.mjs");
  assert.match(workflow, /branches:[\s\S]*- main/);
  assert.match(workflow, /workflows:[\s\S]*- Native release builds/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm run pages:build/);
  assert.match(workflow, /release-metadata\.mjs[\s\S]*native-dist\/downloads\/availability\.json/);
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4[\s\S]*path: native-dist/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(preparer, /public["',\s]+downloads["',\s]+availability\.json/);
  assert.match(preparer, /\.nojekyll/);
  assert.match(preparer, /404\.html/);
});

test("mobile timer uses a persisted deadline instead of interval subtraction", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /endAt - Date\.now\(\)/);
  assert.doesNotMatch(page, /current > 1.*current - 1/);
});

test("focus minutes can be chosen directly and sync excludes device-only preferences", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const privateSync = await readFile(new URL("../app/lib/private-sync.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(page, /className="custom-duration"/);
  assert.match(page, /commitCustomMinutes/);
  assert.match(page, /inputMode="numeric"/);
  assert.match(page, /const MIN_TIMER_MINUTES = 5/);
  assert.match(page, /Math\.round\(finiteValue \/ TIMER_MINUTE_STEP\) \* TIMER_MINUTE_STEP/);
  assert.match(page, /min=\{MIN_TIMER_MINUTES\}/);
  assert.match(page, /step=\{TIMER_MINUTE_STEP\}/);
  assert.match(page, /<fieldset className="timer-rhythm">/);
  assert.doesNotMatch(page, /className="duration-grid"/);
  assert.doesNotMatch(styles, /\.duration-grid/);
  assert.match(translations.en.timerDurationRange, /5-minute steps.*5 to \{max\}/);
  assert.match(translations.zh.timerDurationRange, /每次調整 5 分鐘.*5 至 \{max\}/);
  assert.match(page, /type=\{showPairingCode \? "text" : "password"\}/);
  assert.match(page, /setSyncSetupOpen/);
  assert.match(page, /useState\("1970-01-01T00:00:00\.000Z"\)/);
  assert.match(page, /readLocalSyncConfig<SyncConfig>\(\)/);
  assert.match(privateSync, /excludes language, sound, current intent, and an active timer/);
  assert.equal(translations.zh.navInsights, "統計");
});

test("native download copy identifies architecture and preview signing status", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts["desktop:build:win"], /--win nsis --x64/);
  assert.match(packageJson.scripts["desktop:build:linux"], /--linux AppImage deb --x64/);
  assert.match(translations.en.downloadWindows, /x64/i);
  assert.match(translations.en.downloadLinux, /x64/i);
  assert.match(translations.en.downloadAndroid, /debug APK/i);
  assert.match(translations.zh.downloadWindows, /x64/i);
  assert.match(translations.zh.downloadLinux, /x64/i);
  assert.match(translations.zh.downloadAndroid, /debug APK/i);
  assert.match(translations.en.androidDetail, /debug-signed APK/i);
  assert.match(translations.zh.androidDetail, /開發用除錯簽章/);
});

test("repository includes the stated MIT license", async () => {
  const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");
  assert.match(license, /^MIT License/m);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});
