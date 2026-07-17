"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyKey, interpolate, Language, translations } from "./i18n";
import {
  clearLocalSnapshot,
  clearLocalSyncConfig,
  assertLocalSyncLockOwnership,
  readLocalSnapshot,
  readLocalSyncConfig,
  withLocalSyncLock,
  writeLocalSnapshot,
  writeLocalSyncConfig,
} from "./lib/local-store";
import {
  createPairingCode,
  deleteSyncRoom,
  formatPairingCode,
  mergeSyncPayload,
  parsePairingCode,
  syncRound,
  SyncCipherError,
  SyncHttpError,
  SyncPayloadTooLargeError,
  SyncRoomMissingError,
  type SyncConfig,
  type SyncPayload,
} from "./lib/private-sync";
import {
  cancelNativeCompletionNotification,
  exportNativeFile,
  isMobileNativeApp,
  isNativeApp,
  nativeSyncOptions,
  readNativeNotificationPermission,
  requestNativeNotificationPermission,
  scheduleNativeCompletionNotification,
  SYNC_RELAY_CONFIGURED,
} from "./lib/native-runtime";
import { bestFocusHour, FocusSession, focusStreak, localDateKey, weeklyStats } from "./lib/stats";

type Mode = "focus" | "shortBreak" | "longBreak";
type Tone = "chime" | "bell" | "soft";
type SectionId = "focus" | "today" | "insights" | "settings";
type DownloadTarget = "windows" | "linux" | "android";
type DownloadBuild = { href: string; version?: string; size?: string };
type DownloadManifest = { version: 1; releasePage?: string; builds: Partial<Record<DownloadTarget, DownloadBuild>> };
type SyncStatus = "off" | "syncing" | "ready" | "offline" | "error";
type Task = { id: string; label: string; done: boolean; updatedAt: string; deletedAt?: string };
type TimerSettings = {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  dailyGoal: number;
  tone: Tone;
};
type TimerSnapshot = {
  mode: Mode;
  secondsLeft: number;
  endAt: number | null;
  plannedMinutes: number;
  startedAt: number | null;
};
type StoredData = {
  version: 4;
  sessions: FocusSession[];
  tasks: Task[];
  settings: TimerSettings;
  settingsUpdatedAt: string;
  language?: Language;
  currentIntent: string;
  currentIntentUpdatedAt: string;
  timer: TimerSnapshot;
  focusRound: number;
  lastBackupAt: string | null;
  lastSyncedAt: string | null;
};
type WakeLockManager = { request(type: "screen"): Promise<{ release(): Promise<void> }> };

const BUILDINGS = [46, 68, 38, 82, 55, 74, 44, 90, 62, 50, 78, 58, 96, 66, 42, 72, 52, 86];
const DEFAULT_SETTINGS: TimerSettings = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, dailyGoal: 100, tone: "chime" };
const TIMER_MODES: readonly Mode[] = ["focus", "shortBreak", "longBreak"];
const MIN_TIMER_MINUTES = 5;
const TIMER_MINUTE_STEP = 5;
const TIMER_MINUTE_LIMITS: Record<Mode, number> = { focus: 180, shortBreak: 60, longBreak: 90 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function normaliseTimerMinutes(value: number, maximum: number) {
  const finiteValue = Number.isFinite(value) ? value : MIN_TIMER_MINUTES;
  return clamp(Math.round(finiteValue / TIMER_MINUTE_STEP) * TIMER_MINUTE_STEP, MIN_TIMER_MINUTES, maximum);
}

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function durationFor(mode: Mode, settings: TimerSettings) {
  if (mode === "shortBreak") return settings.shortBreakMinutes;
  if (mode === "longBreak") return settings.longBreakMinutes;
  return settings.focusMinutes;
}

function durationKeyFor(mode: Mode): "focusMinutes" | "shortBreakMinutes" | "longBreakMinutes" {
  if (mode === "shortBreak") return "shortBreakMinutes";
  if (mode === "longBreak") return "longBreakMinutes";
  return "focusMinutes";
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function stableId(prefix: string, value: unknown) {
  if (typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) ? `legacy-${prefix}-${number}` : `legacy-${prefix}-${crypto.randomUUID()}`;
}

function newId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sameSyncConnection(left: SyncConfig | null, right: SyncConfig | null) {
  return Boolean(left && right && left.roomId === right.roomId && left.rootSecret === right.rootSecret);
}

function normaliseData(value: unknown): StoredData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.sessions) || !Array.isArray(raw.tasks)) return null;

  const parsedSessions = raw.sessions.slice(-5000).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const session = item as Partial<FocusSession>;
    const minutes = clamp(Number(session.minutes), 1, 600);
    if (!isValidDate(session.completedAt)) return [];
    const completedAt = String(session.completedAt);
    const updatedAt = isValidDate(session.updatedAt) ? session.updatedAt : completedAt;
    const source: FocusSession["source"] = session.source === "manual" ? "manual" : "timer";
    return [{
      id: stableId("session", session.id), minutes, completedAt, updatedAt,
      deletedAt: isValidDate(session.deletedAt) ? session.deletedAt : undefined,
      source,
      label: typeof session.label === "string" ? session.label.slice(0, 120) : undefined,
      note: typeof session.note === "string" ? session.note.slice(0, 300) : undefined,
      rating: session.rating === 1 || session.rating === 2 || session.rating === 3 ? session.rating : undefined,
    }];
  });
  const sessions = [...new Map(parsedSessions.map((session) => [session.id, session])).values()];
  const parsedTasks = raw.tasks.slice(-200).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const task = item as Partial<Task>;
    if (typeof task.label !== "string" || !task.label.trim()) return [];
    const fallbackDate = Number.isFinite(Number(task.id)) ? new Date(Number(task.id)).toISOString() : "1970-01-01T00:00:00.000Z";
    return [{
      id: stableId("task", task.id),
      label: task.label.trim().slice(0, 120),
      done: Boolean(task.done),
      updatedAt: isValidDate(task.updatedAt) ? task.updatedAt : fallbackDate,
      deletedAt: isValidDate(task.deletedAt) ? task.deletedAt : undefined,
    }];
  });
  const tasks = [...new Map(parsedTasks.map((task) => [task.id, task])).values()];
  const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings as Partial<TimerSettings> : {};
  const legacyGoal = Number(raw.dailyGoal);
  const legacyTone = raw.tone;
  const candidateTone = rawSettings.tone ?? legacyTone;
  const tone: Tone = candidateTone === "bell" || candidateTone === "soft" ? candidateTone : "chime";
  const settings: TimerSettings = {
    focusMinutes: normaliseTimerMinutes(Number(rawSettings.focusMinutes ?? 25), TIMER_MINUTE_LIMITS.focus),
    shortBreakMinutes: normaliseTimerMinutes(Number(rawSettings.shortBreakMinutes ?? 5), TIMER_MINUTE_LIMITS.shortBreak),
    longBreakMinutes: normaliseTimerMinutes(Number(rawSettings.longBreakMinutes ?? 15), TIMER_MINUTE_LIMITS.longBreak),
    dailyGoal: clamp(Number(rawSettings.dailyGoal ?? (Number.isFinite(legacyGoal) ? legacyGoal : 100)), 5, 600),
    tone,
  };
  const rawTimer = raw.timer && typeof raw.timer === "object" ? raw.timer as Partial<TimerSnapshot> : {};
  const mode: Mode = rawTimer.mode === "shortBreak" || rawTimer.mode === "longBreak" ? rawTimer.mode : "focus";
  const maximum = durationFor(mode, settings) * 60;
  const endAt = Number(rawTimer.endAt);
  const normalisedEndAt = Number.isFinite(endAt) && endAt > 0 ? endAt : null;
  const plannedMinutes = normaliseTimerMinutes(Number(rawTimer.plannedMinutes ?? durationFor(mode, settings)), TIMER_MINUTE_LIMITS[mode]);
  const startedAt = Number(rawTimer.startedAt);

  return {
    version: 4,
    sessions,
    tasks,
    settings,
    settingsUpdatedAt: isValidDate(raw.settingsUpdatedAt) ? raw.settingsUpdatedAt : "1970-01-01T00:00:00.000Z",
    language: raw.language === "en" || raw.language === "zh" ? raw.language : undefined,
    currentIntent: typeof raw.currentIntent === "string" ? raw.currentIntent.slice(0, 120) : "",
    currentIntentUpdatedAt: isValidDate(raw.currentIntentUpdatedAt) ? raw.currentIntentUpdatedAt : "1970-01-01T00:00:00.000Z",
    timer: {
      mode,
      secondsLeft: clamp(Number(rawTimer.secondsLeft ?? maximum), 0, maximum),
      endAt: normalisedEndAt,
      plannedMinutes,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : normalisedEndAt ? normalisedEndAt - plannedMinutes * 60_000 : null,
    },
    focusRound: clamp(Number(raw.focusRound ?? 0), 0, 3),
    lastBackupAt: typeof raw.lastBackupAt === "string" && !Number.isNaN(new Date(raw.lastBackupAt).getTime()) ? raw.lastBackupAt : null,
    lastSyncedAt: isValidDate(raw.lastSyncedAt) ? raw.lastSyncedAt : null,
  };
}

function downloadFile(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function normaliseDownloadManifest(value: unknown): DownloadManifest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DownloadManifest>;
  if (candidate.version !== 1 || !candidate.builds || typeof candidate.builds !== "object") return null;
  const builds: DownloadManifest["builds"] = {};
  for (const target of ["windows", "linux", "android"] as const) {
    const build = candidate.builds[target];
    if (!build || typeof build !== "object") continue;
    if (typeof build.href !== "string") continue;
    let safeHref = /^\/downloads\/[a-z0-9._-]+$/i.test(build.href);
    if (!safeHref) {
      try {
        const url = new URL(build.href);
        safeHref = url.protocol === "https:" && !url.username && !url.password;
      } catch {
        safeHref = false;
      }
    }
    if (!safeHref) continue;
    builds[target] = {
      href: build.href,
      ...(typeof build.version === "string" ? { version: build.version.slice(0, 40) } : {}),
      ...(typeof build.size === "string" ? { size: build.size.slice(0, 40) } : {}),
    };
  }
  let releasePage: string | undefined;
  if (typeof candidate.releasePage === "string") {
    try {
      const url = new URL(candidate.releasePage);
      if (url.protocol === "https:" && url.hostname === "github.com" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/[^/]+$/u.test(url.pathname)) {
        releasePage = url.href;
      }
    } catch {
      // A malformed release URL must never become a link in the download center.
    }
  }
  return { version: 1, ...(releasePage ? { releasePage } : {}), builds };
}

export default function Home() {
  const [activeSection, setActiveSection] = useState<SectionId>("focus");
  const [mode, setMode] = useState<Mode>("focus");
  const [secondsLeft, setSecondsLeft] = useState(DEFAULT_SETTINGS.focusMinutes * 60);
  const [endAt, setEndAt] = useState<number | null>(null);
  const [plannedMinutes, setPlannedMinutes] = useState(DEFAULT_SETTINGS.focusMinutes);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [sessions, setSessions] = useState<FocusSession[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<TimerSettings>(DEFAULT_SETTINGS);
  const [settingsUpdatedAt, setSettingsUpdatedAt] = useState("1970-01-01T00:00:00.000Z");
  const [currentIntent, setCurrentIntent] = useState("");
  const [currentIntentUpdatedAt, setCurrentIntentUpdatedAt] = useState(() => new Date().toISOString());
  const [focusRound, setFocusRound] = useState(0);
  const [newTask, setNewTask] = useState("");
  const [manualMinutes, setManualMinutes] = useState(25);
  const [customMinutesInput, setCustomMinutesInput] = useState<string | null>(null);
  const [language, setLanguage] = useState<Language>("en");
  const [notice, setNotice] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>("default");
  const [nativeApp, setNativeApp] = useState(false);
  const [downloadBuilds, setDownloadBuilds] = useState<DownloadManifest["builds"]>({});
  const [releasePage, setReleasePage] = useState<string | null>(null);
  const [storageProtected, setStorageProtected] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncConfig, setSyncConfig] = useState<SyncConfig | null>(null);
  const [syncConfigLoaded, setSyncConfigLoaded] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [showPairingCode, setShowPairingCode] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("off");
  const [connecting, setConnecting] = useState(false);
  const [syncSetupOpen, setSyncSetupOpen] = useState(false);
  const [reflectionId, setReflectionId] = useState<string | null>(null);
  const [reflectionNote, setReflectionNote] = useState("");
  const [reflectionRating, setReflectionRating] = useState<1 | 2 | 3>(2);
  const audioRef = useRef<AudioContext | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const syncConfigRef = useRef<SyncConfig | null>(null);
  const syncPayloadRef = useRef<SyncPayload | null>(null);
  const syncInFlightRef = useRef(false);
  const syncQueuedRef = useRef(false);
  const performSyncRef = useRef<((config?: SyncConfig, requireExisting?: boolean, lockHeld?: boolean) => Promise<SyncPayload | null>) | null>(null);
  const connectionEpochRef = useRef(0);
  const connectingRef = useRef(false);
  const syncChannelRef = useRef<BroadcastChannel | null>(null);
  const copy = translations[language];
  const running = endAt !== null;
  const syncAvailable = SYNC_RELAY_CONFIGURED && nativeApp;

  const tr = useCallback((key: CopyKey, values?: Record<string, string | number>) => {
    const value = copy[key];
    return values ? interpolate(value, values) : value;
  }, [copy]);
  const syncErrorMessage = useCallback((error: unknown) => {
    if (error instanceof SyncPayloadTooLargeError || (error instanceof SyncHttpError && error.status === 413)) return tr("syncTooLarge");
    if (error instanceof SyncCipherError) return tr("syncCipherInvalid");
    if (error instanceof SyncHttpError && ((error.status >= 300 && error.status < 400) || error.status === 401 || error.status === 403)) {
      return tr("syncRelayUnavailable");
    }
    return tr("syncFailed");
  }, [tr]);

  const playTone = useCallback((override?: Tone) => {
    try {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioRef.current ??= new AudioCtx();
      const context = audioRef.current;
      void context.resume();
      const selectedTone = override ?? settings.tone;
      const frequencies = selectedTone === "bell" ? [784, 1174] : selectedTone === "soft" ? [330, 392] : [523.25, 783.99];
      frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = selectedTone === "soft" ? "sine" : "triangle";
        oscillator.frequency.setValueAtTime(frequency, context.currentTime + index * 0.14);
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(selectedTone === "soft" ? 0.05 : 0.12, context.currentTime + 0.03 + index * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.65 + index * 0.14);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(context.currentTime + index * 0.14);
        oscillator.stop(context.currentTime + 0.8 + index * 0.14);
      });
    } catch {
      // Audio is an enhancement; the timer must still complete without it.
    }
  }, [settings.tone]);

  const notifyCompletion = useCallback(async () => {
    if (isMobileNativeApp()) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const options = { body: tr("sessionCompleteBody"), icon: "/icon-192.png", badge: "/icon-192.png" };
    new Notification(tr("sessionComplete"), options);
  }, [tr]);

  useEffect(() => {
    let cancelled = false;
    void readLocalSnapshot<unknown>().then((raw) => {
      if (cancelled) return;
      const data = normaliseData(raw);
      const detectedLanguage: Language = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
      const installedNative = isNativeApp();
      queueMicrotask(() => {
        if (data) {
          setSessions(data.sessions);
          setTasks(data.tasks);
          setSettings(data.settings);
          setSettingsUpdatedAt(data.settingsUpdatedAt);
          setLanguage(data.language ?? detectedLanguage);
          setCurrentIntent(data.currentIntent);
          setCurrentIntentUpdatedAt(data.currentIntentUpdatedAt);
          setFocusRound(data.focusRound);
          setMode(data.timer.mode);
          setSecondsLeft(data.timer.secondsLeft);
          setEndAt(data.timer.endAt);
          setPlannedMinutes(data.timer.plannedMinutes);
          setStartedAt(data.timer.startedAt);
          setLastBackupAt(data.lastBackupAt);
          setLastSyncedAt(data.lastSyncedAt);
        } else {
          setLanguage(detectedLanguage);
        }
        setNativeApp(installedNative);
        const hashSection = window.location.hash.slice(1);
        if (hashSection === "focus" || hashSection === "today" || hashSection === "insights" || hashSection === "settings") setActiveSection(hashSection);
        if (installedNative) setStorageProtected(true);
        setHydrated(true);
      });
      void readNativeNotificationPermission().then((permission) => {
        if (!cancelled) setNotificationPermission(permission ?? (typeof Notification === "undefined" ? "denied" : Notification.permission));
      }).catch(() => {
        if (!cancelled) setNotificationPermission(typeof Notification === "undefined" ? "denied" : Notification.permission);
      });
    });

    // Older releases registered a PWA service worker. Remove it and its caches now that
    // durable use is intentionally reserved for installed native apps.
    if (!isNativeApp() && "serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => undefined);
      if ("caches" in window) {
        void caches.keys()
          .then((keys) => Promise.all(keys.filter((key) => key.startsWith("afterglow-")).map((key) => caches.delete(key))))
          .catch(() => undefined);
      }
    }
    if (!isNativeApp() && navigator.storage?.persisted) {
      void navigator.storage.persisted()
        .then((value) => queueMicrotask(() => setStorageProtected(value)))
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || nativeApp) return;
    let cancelled = false;
    const manifestUrl = new URL("downloads/availability.json", document.baseURI);
    void fetch(manifestUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return null;
      return normaliseDownloadManifest(await response.json());
    }).then((manifest) => {
      if (!cancelled && manifest?.version === 1 && manifest.builds && typeof manifest.builds === "object") {
        setDownloadBuilds(manifest.builds);
        setReleasePage(manifest.releasePage ?? null);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [hydrated, nativeApp]);

  useEffect(() => {
    let cancelled = false;
    let refreshId = 0;
    const refreshFromStorage = async () => {
      const requestId = ++refreshId;
      try {
        const stored = await readLocalSyncConfig<SyncConfig>();
        if (cancelled || requestId !== refreshId) return;
        const current = syncConfigRef.current;
        if (!stored) {
          if (current) connectionEpochRef.current += 1;
          syncQueuedRef.current = false;
          syncConfigRef.current = null;
          setSyncConfig(null);
          setSyncSetupOpen(false);
          setPairingCode("");
          setShowPairingCode(false);
          setLastSyncedAt(null);
          setSyncStatus("off");
          setSyncConfigLoaded(true);
          return;
        }
        const code = await formatPairingCode(stored);
        if (cancelled || requestId !== refreshId) return;
        if (!sameSyncConnection(current, stored) || current?.highestAcceptedGeneration !== stored.highestAcceptedGeneration) {
          connectionEpochRef.current += 1;
          syncQueuedRef.current = false;
          syncConfigRef.current = stored;
          setSyncConfig(stored);
        }
        setSyncSetupOpen(false);
        setPairingCode(code);
        setSyncStatus(SYNC_RELAY_CONFIGURED && isNativeApp() ? (navigator.onLine ? "ready" : "offline") : "error");
        setSyncConfigLoaded(true);
      } catch {
        if (!cancelled && requestId === refreshId) {
          setSyncStatus("error");
          setSyncConfigLoaded(true);
        }
      }
    };
    void refreshFromStorage();

    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("afterglow-private-sync");
    if (channel) {
      syncChannelRef.current = channel;
      channel.onmessage = () => { void refreshFromStorage(); };
    }
    const onStorage = (event: StorageEvent) => { if (event.key === "afterglow-private-sync") void refreshFromStorage(); };
    const onFocus = () => { void refreshFromStorage(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void refreshFromStorage(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      channel?.close();
      if (syncChannelRef.current === channel) syncChannelRef.current = null;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // While running, endAt is the durable source of truth; avoid rewriting the full native snapshot every tick.
  const storedSecondsLeft = endAt === null ? secondsLeft : plannedMinutes * 60;

  useEffect(() => {
    if (!hydrated) return;
    document.documentElement.lang = language === "zh" ? "zh-Hant" : "en";
    const snapshot: StoredData = {
      version: 4, sessions, tasks, settings, settingsUpdatedAt, language, currentIntent, currentIntentUpdatedAt,
      timer: { mode, secondsLeft: storedSecondsLeft, endAt, plannedMinutes, startedAt }, focusRound, lastBackupAt, lastSyncedAt,
    };
    const timer = window.setTimeout(() => void writeLocalSnapshot(snapshot).catch(() => setNotice(tr("storageWriteFailed"))), 250);
    return () => window.clearTimeout(timer);
  }, [sessions, tasks, settings, settingsUpdatedAt, language, currentIntent, currentIntentUpdatedAt, mode, storedSecondsLeft, endAt, plannedMinutes, startedAt, focusRound, lastBackupAt, lastSyncedAt, hydrated, tr]);

  useEffect(() => {
    if (!hydrated || endAt === null || endAt <= Date.now()) return;
    void scheduleNativeCompletionNotification(tr("sessionComplete"), tr("sessionCompleteBody"), endAt).catch(() => undefined);
  }, [endAt, hydrated, notificationPermission, tr]);

  const finishTimer = useCallback((completedAt: number) => {
    playTone();
    void notifyCompletion();
    if (mode === "focus") {
      const id = newId("session");
      const timestamp = new Date(completedAt).toISOString();
      const session: FocusSession = {
        id,
        minutes: plannedMinutes,
        completedAt: timestamp,
        updatedAt: timestamp,
        source: "timer",
        label: currentIntent.trim() || undefined,
      };
      const completedRound = focusRound + 1;
      const nextMode: Mode = completedRound >= 4 ? "longBreak" : "shortBreak";
      setSessions((items) => [...items, session]);
      setFocusRound(completedRound >= 4 ? 0 : completedRound);
      setReflectionId(id);
      setReflectionNote("");
      setReflectionRating(2);
      setMode(nextMode);
      setSecondsLeft(durationFor(nextMode, settings) * 60);
      setPlannedMinutes(durationFor(nextMode, settings));
      setStartedAt(null);
    } else {
      setMode("focus");
      setSecondsLeft(settings.focusMinutes * 60);
      setPlannedMinutes(settings.focusMinutes);
      setStartedAt(null);
    }
  }, [currentIntent, focusRound, mode, notifyCompletion, plannedMinutes, playTone, settings]);

  useEffect(() => {
    if (endAt === null) return;
    let completed = false;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0 && !completed) {
        completed = true;
        setEndAt(null);
        finishTimer(endAt);
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [endAt, finishTimer]);

  useEffect(() => {
    if (!running) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockManager }).wakeLock;
    if (!wakeLock) return;
    let released = false;
    let sentinel: { release(): Promise<void> } | null = null;
    void wakeLock.request("screen").then((lock) => {
      if (released) void lock.release();
      else sentinel = lock;
    }).catch(() => undefined);
    return () => {
      released = true;
      if (sentinel) void sentinel.release();
    };
  }, [running]);

  useEffect(() => {
    document.title = running ? `${formatTime(secondsLeft)} · Afterglow` : language === "zh" ? "Afterglow — 本機專注計時器" : "Afterglow — Private focus timer";
  }, [language, running, secondsLeft]);

  const resetTimer = useCallback(() => {
    void cancelNativeCompletionNotification().catch(() => undefined);
    setEndAt(null);
    setSecondsLeft(durationFor(mode, settings) * 60);
    setPlannedMinutes(durationFor(mode, settings));
    setStartedAt(null);
  }, [mode, settings]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) || target.isContentEditable) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (endAt) {
          void cancelNativeCompletionNotification().catch(() => undefined);
          setSecondsLeft(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
          setEndAt(null);
        } else {
          try {
            const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            audioRef.current ??= new AudioCtx();
            void audioRef.current.resume();
          } catch {
            // Keyboard timer control works even when audio is unavailable.
          }
          const now = Date.now();
          const target = now + secondsLeft * 1000;
          setStartedAt((value) => value ?? now);
          setEndAt(target);
        }
      }
      if (event.key.toLowerCase() === "r") resetTimer();
      if (event.key.toLowerCase() === "l") setLanguage((value) => value === "en" ? "zh" : "en");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [endAt, resetTimer, secondsLeft]);

  useEffect(() => {
    if (reflectionId === null) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(".modal-backdrop [role='dialog']");
    const focusable = () => dialog ? [...dialog.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("disabled")) : [];
    queueMicrotask(() => focusable()[0]?.focus());
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setReflectionId(null);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      previousFocus?.focus();
    };
  }, [reflectionId]);

  const activeSessions = useMemo(() => sessions.filter((session) => !session.deletedAt), [sessions]);
  const activeTasks = useMemo(() => tasks.filter((task) => !task.deletedAt), [tasks]);
  const todaySessions = useMemo(() => activeSessions.filter((session) => localDateKey(new Date(session.completedAt)) === localDateKey(new Date())), [activeSessions]);
  const todayMinutes = todaySessions.reduce((total, session) => total + session.minutes, 0);
  const completedTasks = activeTasks.filter((task) => task.done).length;
  const lights = Math.min(BUILDINGS.length * 5, todaySessions.length * 7 + completedTasks * 3);
  const goalProgress = Math.min(100, Math.round((todayMinutes / settings.dailyGoal) * 100));
  const week = useMemo(() => weeklyStats(activeSessions), [activeSessions]);
  const weekTotal = week.reduce((sum, day) => sum + day.minutes, 0);
  const weekMax = Math.max(1, ...week.map((day) => day.minutes));
  const streak = useMemo(() => focusStreak(activeSessions), [activeSessions]);
  const bestHour = useMemo(() => bestFocusHour(activeSessions), [activeSessions]);
  const locale = language === "zh" ? "zh-TW" : "en";
  const cycle = focusRound + 1;
  const syncRoomId = syncConfig?.roomId ?? null;

  const localSyncPayload = useMemo<SyncPayload>(() => ({
    version: 1,
    generation: syncConfig?.highestAcceptedGeneration ?? 0,
    tasks,
    sessions,
    preferences: {
      focusMinutes: settings.focusMinutes,
      shortBreakMinutes: settings.shortBreakMinutes,
      longBreakMinutes: settings.longBreakMinutes,
      dailyGoal: settings.dailyGoal,
      updatedAt: settingsUpdatedAt,
    },
  }), [sessions, settings.dailyGoal, settings.focusMinutes, settings.longBreakMinutes, settings.shortBreakMinutes, settingsUpdatedAt, syncConfig?.highestAcceptedGeneration, tasks]);
  const syncFingerprint = useMemo(() => JSON.stringify({ tasks, sessions, preferences: localSyncPayload.preferences }), [localSyncPayload.preferences, sessions, tasks]);

  useEffect(() => { syncPayloadRef.current = localSyncPayload; }, [localSyncPayload]);
  useEffect(() => { syncConfigRef.current = syncConfig; }, [syncConfig]);

  const performSync = useCallback(async (overrideConfig?: SyncConfig, requireExisting = false, lockHeld = false) => {
    const run = async () => {
    if (!SYNC_RELAY_CONFIGURED || !isNativeApp()) {
      setSyncStatus("error");
      throw new Error("Encrypted sync relay is not configured for this release.");
    }
    let config = overrideConfig ?? syncConfigRef.current;
    const startingPayload = syncPayloadRef.current;
    const operationEpoch = connectionEpochRef.current;
    if (!config || !startingPayload) return null;
    if (connectingRef.current && !overrideConfig) return null;
    if (!overrideConfig) {
      const durableConfig = await readLocalSyncConfig<SyncConfig>();
      if (!durableConfig || !sameSyncConnection(config, durableConfig)) {
        connectionEpochRef.current += 1;
        syncQueuedRef.current = false;
        syncConfigRef.current = null;
        setSyncConfig(null);
        setPairingCode("");
        setShowPairingCode(false);
        setLastSyncedAt(null);
        setSyncStatus("off");
        return null;
      }
      config = durableConfig;
    }
    if (!navigator.onLine) {
      setSyncStatus("offline");
      return null;
    }
    if (syncInFlightRef.current) {
      if (overrideConfig) throw new Error("Another sync connection is already being established.");
      syncQueuedRef.current = true;
      return null;
    }

    syncInFlightRef.current = true;
    setSyncStatus("syncing");
    try {
      const result = await syncRound(config, {
        ...startingPayload,
        generation: Math.max(startingPayload.generation, config.highestAcceptedGeneration),
      }, { ...nativeSyncOptions(), requireExisting });
      if (operationEpoch !== connectionEpochRef.current) return null;
      const latestPayload = syncPayloadRef.current ?? startingPayload;
      const merged = mergeSyncPayload(result.payload, latestPayload);
      await writeLocalSyncConfig(result.config, overrideConfig
        ? { requireEmpty: true }
        : { expectedIdentity: { roomId: config.roomId, rootSecret: config.rootSecret } });
      await assertLocalSyncLockOwnership();
      if (operationEpoch !== connectionEpochRef.current) {
        return null;
      }
      setTasks(merged.tasks);
      setSessions(merged.sessions);
      setSettings((current) => ({
        ...current,
        focusMinutes: normaliseTimerMinutes(merged.preferences.focusMinutes, TIMER_MINUTE_LIMITS.focus),
        shortBreakMinutes: normaliseTimerMinutes(merged.preferences.shortBreakMinutes, TIMER_MINUTE_LIMITS.shortBreak),
        longBreakMinutes: normaliseTimerMinutes(merged.preferences.longBreakMinutes, TIMER_MINUTE_LIMITS.longBreak),
        dailyGoal: merged.preferences.dailyGoal,
      }));
      setSettingsUpdatedAt(merged.preferences.updatedAt);
      syncConfigRef.current = result.config;
      setSyncConfig(result.config);
      const syncedAt = new Date().toISOString();
      setLastSyncedAt(syncedAt);
      setSyncStatus("ready");
      return merged;
    } catch (error) {
      if (operationEpoch === connectionEpochRef.current) setSyncStatus(navigator.onLine ? "error" : "offline");
      throw error;
    } finally {
      syncInFlightRef.current = false;
      if (syncQueuedRef.current && operationEpoch === connectionEpochRef.current) {
        syncQueuedRef.current = false;
        window.setTimeout(() => void performSyncRef.current?.().catch(() => undefined), 120);
      }
    }
    };
    return lockHeld ? run() : withLocalSyncLock(run);
  }, []);
  useEffect(() => { performSyncRef.current = performSync; }, [performSync]);

  useEffect(() => {
    if (!syncAvailable || !hydrated || !syncRoomId) return;
    const timer = window.setTimeout(() => void performSync().catch(() => undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [hydrated, performSync, syncAvailable, syncFingerprint, syncRoomId]);

  useEffect(() => {
    if (!syncAvailable || !syncRoomId) return;
    const trigger = () => void performSync().catch(() => undefined);
    const onOffline = () => setSyncStatus("offline");
    const onVisibility = () => { if (document.visibilityState === "visible") trigger(); };
    window.addEventListener("online", trigger);
    window.addEventListener("focus", trigger);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(trigger, 30_000);
    return () => {
      window.removeEventListener("online", trigger);
      window.removeEventListener("focus", trigger);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [performSync, syncAvailable, syncRoomId]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    if (!desktop.matches || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      const id = visible?.target.id;
      if (id === "focus" || id === "today" || id === "insights" || id === "settings") setActiveSection(id);
    }, { rootMargin: "-22% 0px -58% 0px", threshold: [0.05, 0.25, 0.6] });
    (["focus", "today", "insights", "settings"] as SectionId[]).forEach((id) => {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    });
    return () => observer.disconnect();
  }, []);

  function changeSettings(update: (current: TimerSettings) => TimerSettings) {
    setSettings(update);
    setSettingsUpdatedAt(new Date().toISOString());
  }

  function changeIntent(value: string) {
    setCurrentIntent(value.slice(0, 120));
    setCurrentIntentUpdatedAt(new Date().toISOString());
  }

  function navigate(section: SectionId) {
    setActiveSection(section);
    window.requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function skipToTimer() {
    setActiveSection("focus");
    window.requestAnimationFrame(() => {
      const timer = document.getElementById("timer");
      timer?.scrollIntoView({ block: "center" });
      timer?.focus();
    });
  }

  function switchMode(nextMode: Mode) {
    void cancelNativeCompletionNotification().catch(() => undefined);
    setEndAt(null);
    setMode(nextMode);
    setSecondsLeft(durationFor(nextMode, settings) * 60);
    setPlannedMinutes(durationFor(nextMode, settings));
    setStartedAt(null);
    setCustomMinutesInput(null);
  }

  function toggleTimer() {
    if (running) {
      void cancelNativeCompletionNotification().catch(() => undefined);
      setSecondsLeft(Math.max(0, Math.ceil(((endAt ?? Date.now()) - Date.now()) / 1000)));
      setEndAt(null);
      return;
    }
    try {
      const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioRef.current ??= new AudioCtx();
      void audioRef.current.resume();
    } catch {
      // Timer operation does not depend on audio availability.
    }
    const seconds = secondsLeft > 0 ? secondsLeft : durationFor(mode, settings) * 60;
    setSecondsLeft(seconds);
    const now = Date.now();
    const target = now + seconds * 1000;
    setStartedAt((value) => value ?? now);
    setEndAt(target);
  }

  function choosePreset(minutes: number) {
    const normalisedMinutes = normaliseTimerMinutes(minutes, TIMER_MINUTE_LIMITS.focus);
    void cancelNativeCompletionNotification().catch(() => undefined);
    setEndAt(null);
    setMode("focus");
    changeSettings((value) => ({ ...value, focusMinutes: normalisedMinutes }));
    setSecondsLeft(normalisedMinutes * 60);
    setPlannedMinutes(normalisedMinutes);
    setStartedAt(null);
    setCustomMinutesInput(null);
  }

  function commitCustomMinutes() {
    const key = durationKeyFor(mode);
    const currentMinutes = durationFor(mode, settings);
    updateDuration(key, Number(customMinutesInput || currentMinutes));
    setCustomMinutesInput(null);
  }

  function updateDuration(key: "focusMinutes" | "shortBreakMinutes" | "longBreakMinutes", value: number) {
    if (running) return;
    const affectedMode: Mode = key === "focusMinutes" ? "focus" : key === "shortBreakMinutes" ? "shortBreak" : "longBreak";
    const minutes = normaliseTimerMinutes(value, TIMER_MINUTE_LIMITS[affectedMode]);
    changeSettings((current) => ({ ...current, [key]: minutes }));
    if (!running && mode === affectedMode) {
      setSecondsLeft(minutes * 60);
      setPlannedMinutes(minutes);
      setStartedAt(null);
    }
  }

  function adjustSelectedDuration(delta: -1 | 1) {
    const currentMinutes = durationFor(mode, settings);
    updateDuration(durationKeyFor(mode), currentMinutes + delta * TIMER_MINUTE_STEP);
    setCustomMinutesInput(null);
  }

  function addTask(event: FormEvent) {
    event.preventDefault();
    const label = newTask.trim();
    if (!label) return;
    const now = new Date().toISOString();
    setTasks((items) => [...items, { id: newId("task"), label: label.slice(0, 120), done: false, updatedAt: now }]);
    setNewTask("");
  }

  function logSession(event: FormEvent) {
    event.preventDefault();
    const minutes = clamp(Number(manualMinutes), 1, 600);
    const now = new Date().toISOString();
    setSessions((items) => [...items, { id: newId("session"), minutes, completedAt: now, updatedAt: now, source: "manual", label: currentIntent.trim() || undefined }]);
    setNotice(tr("sessionAdded", { minutes }));
  }

  async function exportJson() {
    const now = new Date().toISOString();
    const payload: StoredData = { version: 4, sessions, tasks, settings, settingsUpdatedAt, language, currentIntent, currentIntentUpdatedAt, timer: { mode, secondsLeft, endAt, plannedMinutes, startedAt }, focusRound, lastBackupAt: now, lastSyncedAt };
    const filename = `afterglow-backup-${now.slice(0, 10)}.json`;
    const contents = JSON.stringify(payload, null, 2);
    try {
      if (!await exportNativeFile(filename, contents)) downloadFile(filename, contents, "application/json");
      setLastBackupAt(now);
      setNotice(tr("backupDownloaded"));
    } catch {
      setNotice(tr("exportFailed"));
    }
  }

  async function exportCsv() {
    const escape = (value: unknown) => {
      const raw = String(value ?? "");
      const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const rows = [["completed_at", "minutes", "intention", "reflection", "focus_rating"], ...activeSessions.map((session) => [session.completedAt, session.minutes, session.label ?? "", session.note ?? "", session.rating ?? ""] )];
    const filename = `afterglow-history-${new Date().toISOString().slice(0, 10)}.csv`;
    const contents = `\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\n")}`;
    try {
      if (!await exportNativeFile(filename, contents)) downloadFile(filename, contents, "text/csv;charset=utf-8");
      setNotice(tr("csvDownloaded"));
    } catch {
      setNotice(tr("exportFailed"));
    }
  }

  async function importData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Backup too large");
      const data = normaliseData(JSON.parse(await file.text()));
      if (!data) throw new Error("Invalid backup");
      setSessions(data.sessions);
      setTasks(data.tasks);
      setSettings(data.settings);
      setSettingsUpdatedAt(data.settingsUpdatedAt);
      setLanguage(data.language ?? (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en"));
      setCurrentIntent(data.currentIntent);
      setCurrentIntentUpdatedAt(data.currentIntentUpdatedAt);
      setFocusRound(data.focusRound);
      setMode(data.timer.mode);
      setSecondsLeft(data.timer.secondsLeft);
      void cancelNativeCompletionNotification().catch(() => undefined);
      setEndAt(null);
      setPlannedMinutes(data.timer.plannedMinutes);
      setStartedAt(null);
      setLastBackupAt(data.lastBackupAt);
      setLastSyncedAt(data.lastSyncedAt);
      setNotice(tr("backupRestored"));
    } catch {
      setNotice(tr("invalidBackup"));
    }
    event.target.value = "";
  }

  async function enableNotifications() {
    if (isMobileNativeApp()) {
      const permission = await requestNativeNotificationPermission().catch(() => "denied" as const);
      setNotificationPermission(permission ?? "denied");
      if (permission !== "granted") setNotice(tr("notificationDenied"));
      return;
    }
    if (typeof Notification === "undefined") return setNotice(tr("notificationDenied"));
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission !== "granted") setNotice(tr("notificationDenied"));
  }

  async function protectStorage() {
    if (nativeApp) {
      setNotice(tr("nativeStorageCopy"));
      return;
    }
    if (!navigator.storage?.persist) {
      setNotice(tr("storageUnavailable"));
      return;
    }
    const granted = await navigator.storage.persist();
    setStorageProtected(granted);
    setNotice(granted ? tr("storageGranted") : tr("storageDenied"));
  }

  async function createPrivateSync() {
    if (!syncConfigLoaded || connectingRef.current) return;
    if (!syncAvailable) {
      setSyncStatus("error");
      setNotice(tr("syncRelayUnavailable"));
      return;
    }
    if (!navigator.onLine) {
      setSyncStatus("offline");
      setNotice(tr("syncUnavailable"));
      return;
    }
    connectingRef.current = true;
    setConnecting(true);
    try {
      await withLocalSyncLock(async () => {
        if (await readLocalSyncConfig<SyncConfig>()) throw new Error("A sync connection already exists.");
        const code = await createPairingCode();
        const config = await parsePairingCode(code);
        const merged = await performSync(config, false, true);
        if (!merged) throw new Error("Sync did not start");
        setPairingCode(code);
        setSyncSetupOpen(false);
      });
      syncChannelRef.current?.postMessage({ type: "connected" });
      setNotice(tr("syncCreated"));
    } catch (error) {
      setNotice(syncErrorMessage(error));
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }

  async function joinPrivateSync(event: FormEvent) {
    event.preventDefault();
    if (!syncConfigLoaded || connectingRef.current) return;
    if (!syncAvailable) {
      setSyncStatus("error");
      setNotice(tr("syncRelayUnavailable"));
      return;
    }
    if (!navigator.onLine) {
      setSyncStatus("offline");
      setNotice(tr("syncUnavailable"));
      return;
    }
    connectingRef.current = true;
    setConnecting(true);
    let parsed: SyncConfig | null = null;
    try {
      await withLocalSyncLock(async () => {
        if (await readLocalSyncConfig<SyncConfig>()) throw new Error("A sync connection already exists.");
        parsed = await parsePairingCode(joinCode);
        const merged = await performSync(parsed, true, true);
        if (!merged) throw new Error("Sync did not start");
        setPairingCode(await formatPairingCode(parsed));
        setSyncSetupOpen(false);
        setJoinCode("");
      });
      syncChannelRef.current?.postMessage({ type: "connected" });
      setNotice(tr("syncJoined"));
    } catch (error) {
      setNotice(error instanceof SyncRoomMissingError ? tr("syncRoomMissing") : parsed ? syncErrorMessage(error) : tr("invalidSyncCode"));
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }

  async function copyPairingCode() {
    try {
      await navigator.clipboard.writeText(pairingCode);
      setNotice(tr("codeCopied"));
    } catch {
      setNotice(tr("syncFailed"));
    }
  }

  async function sharePairingCode() {
    if (!navigator.share) {
      await copyPairingCode();
      return;
    }
    try {
      await navigator.share({ title: "Afterglow", text: `${tr("syncCode")}: ${pairingCode}` });
    } catch {
      // Canceling the native share sheet is not an error that needs a warning.
    }
  }

  async function manualSync() {
    if (!syncAvailable) {
      setSyncStatus("error");
      setNotice(tr("syncRelayUnavailable"));
      return;
    }
    try {
      const merged = await performSync();
      if (merged) setNotice(tr("syncReady"));
    } catch (error) {
      setNotice(syncErrorMessage(error));
    }
  }

  async function disconnectPrivateSync() {
    if (syncStatus === "syncing" || connectingRef.current) return;
    if (!window.confirm(tr("disconnectConfirm"))) return;
    const previousConfig = syncConfigRef.current;
    if (!previousConfig) return;
    try {
      await withLocalSyncLock(async () => {
        const durableConfig = await readLocalSyncConfig<SyncConfig>();
        if (!sameSyncConnection(previousConfig, durableConfig)) throw new Error("Sync connection changed.");
        connectionEpochRef.current += 1;
        syncQueuedRef.current = false;
        syncConfigRef.current = null;
        await clearLocalSyncConfig(previousConfig);
        await assertLocalSyncLockOwnership();
        setSyncConfig(null);
        setSyncSetupOpen(false);
        setPairingCode("");
        setShowPairingCode(false);
        setLastSyncedAt(null);
        setSyncStatus("off");
        syncChannelRef.current?.postMessage({ type: "disconnect" });
        setNotice(tr("disconnected"));
      });
    } catch {
      const durableConfig = await readLocalSyncConfig<SyncConfig>().catch(() => previousConfig);
      syncConfigRef.current = durableConfig;
      setSyncConfig(durableConfig);
      if (durableConfig) {
        setPairingCode(await formatPairingCode(durableConfig).catch(() => ""));
        setSyncStatus(syncAvailable ? (navigator.onLine ? "ready" : "offline") : "error");
      } else {
        setPairingCode("");
        setSyncStatus("off");
      }
      setNotice(tr("syncFailed"));
    }
  }

  async function removeEncryptedSyncCopy() {
    const config = syncConfigRef.current;
    if (!syncAvailable) {
      setSyncStatus("error");
      setNotice(tr("syncRelayUnavailable"));
      return;
    }
    if (!config || syncStatus === "syncing" || connectingRef.current || !window.confirm(tr("deleteRemoteConfirm"))) return;
    connectingRef.current = true;
    setConnecting(true);
    setSyncStatus("syncing");
    try {
      await withLocalSyncLock(async () => {
        const durableConfig = await readLocalSyncConfig<SyncConfig>();
        if (!sameSyncConnection(config, durableConfig)) throw new Error("Sync connection changed.");
        connectionEpochRef.current += 1;
        syncQueuedRef.current = false;
        let cleared = false;
        try {
          await clearLocalSyncConfig(config);
          cleared = true;
          syncConfigRef.current = null;
          syncChannelRef.current?.postMessage({ type: "disconnect" });
          await deleteSyncRoom(config, nativeSyncOptions());
          await assertLocalSyncLockOwnership();
          setSyncConfig(null);
          setSyncSetupOpen(false);
          setPairingCode("");
          setShowPairingCode(false);
          setLastSyncedAt(null);
          setSyncStatus("off");
          setNotice(tr("remoteDeleted"));
        } catch (error) {
          if (cleared) {
            await writeLocalSyncConfig(config, { requireEmpty: true });
            syncConfigRef.current = config;
            setSyncConfig(config);
            syncChannelRef.current?.postMessage({ type: "connected" });
          }
          throw error;
        }
      });
    } catch (error) {
      const durableConfig = await readLocalSyncConfig<SyncConfig>().catch(() => config);
      syncConfigRef.current = durableConfig;
      setSyncConfig(durableConfig);
      if (durableConfig) {
        setPairingCode(await formatPairingCode(durableConfig).catch(() => ""));
        setSyncStatus(syncAvailable ? (navigator.onLine ? "ready" : "offline") : "error");
      } else {
        setPairingCode("");
        setSyncStatus("off");
      }
      setNotice(syncErrorMessage(error));
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }

  async function clearAllData() {
    if (syncConfigRef.current) {
      setNotice(tr("disconnectBeforeClear"));
      return;
    }
    if (!window.confirm(tr("clearConfirm"))) return;
    try {
      await clearLocalSnapshot();
    } catch {
      setNotice(tr("storageWriteFailed"));
      return;
    }
    void cancelNativeCompletionNotification().catch(() => undefined);
    setEndAt(null);
    setMode("focus");
    setSecondsLeft(DEFAULT_SETTINGS.focusMinutes * 60);
    setPlannedMinutes(DEFAULT_SETTINGS.focusMinutes);
    setStartedAt(null);
    setSessions([]);
    setTasks([]);
    setSettings(DEFAULT_SETTINGS);
    setSettingsUpdatedAt(new Date().toISOString());
    setCurrentIntent("");
    setCurrentIntentUpdatedAt(new Date().toISOString());
    setFocusRound(0);
    setLastBackupAt(null);
    setLastSyncedAt(null);
  }

  function saveReflection() {
    if (reflectionId === null) return;
    const now = new Date().toISOString();
    setSessions((items) => items.map((session) => session.id === reflectionId ? { ...session, note: reflectionNote.trim() || undefined, rating: reflectionRating, updatedAt: now } : session));
    setReflectionId(null);
  }

  const navItems: Array<{ id: SectionId; label: CopyKey; icon: string }> = [
    { id: "focus", label: "navFocus", icon: "◷" },
    { id: "today", label: "navToday", icon: "✓" },
    { id: "insights", label: "navInsights", icon: "▥" },
  ];
  const downloadOptions: Array<{ id: DownloadTarget; title: CopyKey; detail: CopyKey }> = [
    { id: "windows", title: "downloadWindows", detail: "windowsDetail" },
    { id: "linux", title: "downloadLinux", detail: "linuxDetail" },
    { id: "android", title: "downloadAndroid", detail: "androidDetail" },
  ];

  const encryptedSyncActive = syncAvailable && Boolean(syncConfig);
  const syncStatusLabel = !syncAvailable ? tr(SYNC_RELAY_CONFIGURED ? "syncNativeOnly" : "syncNotPublished") : syncStatus === "syncing" ? tr("syncing") : syncStatus === "offline" ? tr("syncOffline") : syncStatus === "error" ? tr("syncFailed") : syncConfig ? tr("syncReady") : tr("syncOff");
  const syncBusy = connecting || syncStatus === "syncing" || !syncConfigLoaded;
  const selectedDuration = durationFor(mode, settings);
  const selectedDurationMaximum = TIMER_MINUTE_LIMITS[mode];
  const selectedDurationLabel: CopyKey = mode === "focus" ? "customMinutes" : mode === "shortBreak" ? "shortBreakLength" : "longBreakLength";

  return (
    <main className="app-shell" data-mobile-active={activeSection}>
      <button type="button" className="skip-link" onClick={skipToTimer}>{tr("skip")}</button>
      <header className="topbar">
        <button className="brand" onClick={() => navigate("focus")} aria-label="Afterglow"><span className="brand-mark">✦</span><span>afterglow</span></button>
        <nav className="primary-nav" aria-label={tr("primaryNavigation")}>
          {navItems.map((item) => <button key={item.id} className={activeSection === item.id ? "active" : ""} aria-current={activeSection === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>{tr(item.label)}</button>)}
        </nav>
        <div className="header-actions">
          <button className="language-chip" onClick={() => setLanguage(language === "en" ? "zh" : "en")} aria-label={tr("switchLanguage")}><span aria-hidden="true">文</span><span>{tr("language")}</span></button>
          <button className={activeSection === "settings" ? "settings-chip active" : "settings-chip"} aria-current={activeSection === "settings" ? "page" : undefined} onClick={() => navigate("settings")} aria-label={tr("openSettings")}><span aria-hidden="true">⚙</span><span>{tr("navSettings")}</span></button>
        </div>
      </header>

      <aside className="local-banner" aria-label={encryptedSyncActive ? tr("encryptedTagline") : tr(nativeApp ? "localTagline" : "browserPreviewTagline")}>
        <span className={encryptedSyncActive ? "local-dot encrypted" : "local-dot"} />
        <strong>{encryptedSyncActive ? tr("encryptedBadge") : tr(nativeApp ? "localBadge" : "browserPreviewBadge")}</strong>
        <span>{encryptedSyncActive ? tr("encryptedTagline") : tr(nativeApp ? "localTagline" : "browserPreviewTagline")}</span>
      </aside>

      <section className="app-section focus-section" id="focus">
        <div className="focus-grid">
          <section className="focus-panel" id="timer" tabIndex={-1}>
            <div className="eyebrow"><span className={running ? "pulse-dot active" : "pulse-dot"} />{running ? tr("inProgress") : tr("ready")}</div>
            <fieldset className="timer-rhythm">
              <legend>{tr("timerSettings")}</legend>
              <p className="rhythm-copy">{tr("timerSettingsCopy")}</p>
              <div className="mode-switch" aria-label={tr("timerSettings")}>
                {TIMER_MODES.map((item) => <button type="button" key={item} className={mode === item ? "selected" : ""} aria-pressed={mode === item} onClick={() => switchMode(item)}><span>{tr(item)}</span><small>{durationFor(item, settings)} {tr("minutesShort")}</small></button>)}
              </div>
              <div className="duration-chooser">
                {mode === "focus" && <div className="presets" aria-label={tr("focusPresets")}>
                  {[15, 25, 50].map((minutes) => <button type="button" key={minutes} disabled={running} aria-pressed={settings.focusMinutes === minutes} className={settings.focusMinutes === minutes ? "active" : ""} onClick={() => choosePreset(minutes)}>{minutes} {tr("minutesShort")}</button>)}
                </div>}
                <div className="custom-duration" role="group" aria-labelledby="selected-duration-label" aria-describedby="selected-duration-range">
                  <button type="button" disabled={running || selectedDuration <= MIN_TIMER_MINUTES} onClick={() => adjustSelectedDuration(-1)} aria-label={tr("decreaseMinutes")}>−</button>
                  <label><span id="selected-duration-label">{tr(selectedDurationLabel)}</span><span><input type="number" inputMode="numeric" min={MIN_TIMER_MINUTES} max={selectedDurationMaximum} step={TIMER_MINUTE_STEP} disabled={running} value={customMinutesInput ?? String(selectedDuration)} onChange={(event) => { if (/^\d{0,3}$/.test(event.target.value)) setCustomMinutesInput(event.target.value); }} onBlur={commitCustomMinutes} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} aria-label={tr(selectedDurationLabel)} aria-describedby="selected-duration-range" /> {tr("minutesShort")}</span></label>
                  <button type="button" disabled={running || selectedDuration >= selectedDurationMaximum} onClick={() => adjustSelectedDuration(1)} aria-label={tr("increaseMinutes")}>＋</button>
                  <small className="duration-range" id="selected-duration-range">{tr("timerDurationRange", { max: selectedDurationMaximum })}</small>
                </div>
              </div>
            </fieldset>
            <label className="intent-field">
              <span>{tr("focusIntent")}</span>
              <div><input value={currentIntent} maxLength={120} onChange={(event) => changeIntent(event.target.value)} placeholder={tr("focusIntentPlaceholder")} />{currentIntent && <button type="button" onClick={() => changeIntent("")}>{tr("clearIntent")}</button>}</div>
            </label>
            <div className="timer" role="timer" aria-live="off" aria-label={`${tr(mode)} ${formatTime(secondsLeft)}`}>{formatTime(secondsLeft)}</div>
            <p className="timer-note">{mode === "focus" ? tr("focusNote") : tr("restNote")}</p>
            <div className="timer-actions"><button className={running ? "start-button pause" : "start-button"} onClick={toggleTimer}><span>{running ? tr("pause") : secondsLeft < durationFor(mode, settings) * 60 ? tr("continue") : mode === "focus" ? tr("begin") : tr("beginBreak")}</span><span aria-hidden="true">{running ? "Ⅱ" : "→"}</span></button><button className="reset-button" onClick={resetTimer} aria-label={tr("resetTimer")}>↺</button></div>
            {endAt && <p className="finish-time">{tr("endsAt", { time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(endAt)) })}</p>}
            {mode === "focus" && <p className="cycle-note">{tr("cycle", { current: cycle })}</p>}
          </section>

          <section className="city-card" aria-label={`${lights} ${tr("windows")}`}>
            <div className="city-copy"><div><p className="eyebrow pale">{tr("todaysSkyline")}</p><h1>{tr("headline")}</h1></div><div className="light-count"><strong>{lights}</strong><span>{tr("windows")}</span></div></div>
            <div className="moon" aria-hidden="true"><span /></div><div className="stars" aria-hidden="true">✦　·　✧　　·　✦　　　　·　✧</div>
            <div className="skyline" aria-hidden="true">{BUILDINGS.map((height, buildingIndex) => <div className="building" key={buildingIndex} style={{ height: `${height}%` }}>{Array.from({ length: 5 }).map((_, windowIndex) => <i key={windowIndex} className={buildingIndex * 5 + windowIndex < lights ? "lit" : ""} />)}</div>)}</div>
            <div className="city-ground"><span>{tr("dayInCity", { count: new Set(activeSessions.map((session) => localDateKey(new Date(session.completedAt)))).size })}</span><span>{tr("cityCaption")}</span></div>
          </section>
        </div>
      </section>

      <section className="app-section today-section" id="today">
        <div className="section-intro"><div><p className="eyebrow">{tr("todayKicker")}</p><h2>{tr("todayTitle")}</h2></div><time dateTime={localDateKey(new Date())}>{new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</time></div>
        <div className="two-column-grid">
          <section className="tasks-card card">
            <div className="card-heading"><div><p className="eyebrow">{tr("promises")}</p><h3>{tr("tasksTitle")}</h3></div><span>{completedTasks}/{activeTasks.length}</span></div>
            <div className="task-list">
              {activeTasks.length === 0 && <p className="empty-state">{tr("addTask")}</p>}
              {activeTasks.map((task) => <div className={task.done ? "task done" : "task"} key={task.id}>
                <button className="check-task" onClick={() => { const now = new Date().toISOString(); setTasks((items) => items.map((item) => item.id === task.id ? { ...item, done: !item.done, updatedAt: now } : item)); }} aria-label={`${task.done ? tr("unmarkTask") : tr("completeTask")} ${task.label}`}>{task.done ? "✓" : ""}</button>
                <span>{task.label}</span>
                <button className={currentIntent === task.label ? "use-task active" : "use-task"} onClick={() => { changeIntent(task.label); navigate("focus"); }}>{currentIntent === task.label ? tr("activeTask") : tr("useTask")}</button>
                <button className="remove-task" onClick={() => { const now = new Date().toISOString(); setTasks((items) => items.map((item) => item.id === task.id ? { ...item, updatedAt: now, deletedAt: now } : item)); }} aria-label={`${tr("remove")} ${task.label}`}>×</button>
              </div>)}
            </div>
            <form className="add-task" onSubmit={addTask}><input value={newTask} maxLength={120} onChange={(event) => setNewTask(event.target.value)} placeholder={tr("addTask")} aria-label={tr("addTask")} /><button aria-label={tr("addTask")}>+</button></form>
          </section>
          <section className="progress-card card"><div className="card-heading"><div><p className="eyebrow pale">{tr("dailyGlow")}</p><h3>{tr("goalPercent", { percent: goalProgress })}</h3></div><span className="mini-sun" aria-hidden="true">☼</span></div><div className="progress-track" role="progressbar" aria-label={tr("dailyGoal")} aria-valuetext={tr("goalPercent", { percent: goalProgress })} aria-valuenow={goalProgress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${goalProgress}%` }} /></div><label className="goal-editor"><span>{tr("dailyGoal")}</span><input type="number" min="5" max="600" step="5" value={settings.dailyGoal} onChange={(event) => changeSettings((value) => ({ ...value, dailyGoal: clamp(Number(event.target.value), 5, 600) }))} /><span>{tr("minutesShort")}</span></label><div className="stats"><div><strong>{todayMinutes}</strong><span>{tr("minutesFocused")}</span></div><div><strong>{todaySessions.length}</strong><span>{tr("sessionsFinished")}</span></div><div><strong>{completedTasks}</strong><span>{tr("tasksDone")}</span></div></div></section>
        </div>
      </section>

      <section className="app-section insights-section" id="insights">
        <div className="section-intro"><div><p className="eyebrow">{tr("insightsKicker")}</p><h2>{tr("insightsTitle")}</h2></div></div>
        <div className="insights-grid">
          <section className="weekly-card card"><div className="card-heading"><div><p className="eyebrow">{tr("weekly")}</p><h3>{tr("weeklyTitle")}</h3><p className="week-summary">{tr("total", { count: weekTotal })}</p></div><div className="streak"><strong>{streak}</strong><span>{tr("streak")}</span></div></div><div className="week-chart" role="img" aria-label={week.map((day) => `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(day.date)} ${day.minutes} ${tr("minutes")}`).join(", ")}>{week.map((day) => <div className="day-bar" key={day.key}><span className="bar-value">{day.minutes || "·"}</span><div><i style={{ height: `${Math.max(day.minutes ? 8 : 2, (day.minutes / weekMax) * 100)}%` }} /></div><span>{new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(day.date)}</span></div>)}</div><div className="best-time"><span>{tr("bestTime")}</span><strong>{bestHour === null ? tr("noBestTime") : new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(new Date(2026, 0, 1, bestHour))}</strong></div></section>
          <section className="history-card card">
            <div className="card-heading"><div><p className="eyebrow">{tr("recent")}</p><h3>{tr("history")}</h3></div><span>{tr("totalSessions", { count: activeSessions.length })}</span></div>
              {activeSessions.length === 0 ? <p className="empty-state">{tr("empty")}</p> : <div className="history-list">{[...activeSessions].sort((left, right) => right.completedAt.localeCompare(left.completedAt)).slice(0, 8).map((session) => <div className="history-row" key={session.id}><span className="history-light" aria-hidden="true">✦</span><div><strong>{session.label || `${session.minutes} ${tr("minutes")}`}</strong><span>{session.minutes} {tr("minutesShort")} · {new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(session.completedAt))}{session.rating ? ` · ${"●".repeat(session.rating)}` : ""}</span>{session.note && <small>{session.note}</small>}</div><button onClick={() => { const now = new Date().toISOString(); setSessions((items) => items.map((item) => item.id === session.id ? { ...item, updatedAt: now, deletedAt: now } : item)); }}>{tr("remove")}</button></div>)}</div>}
            <form className="manual-log" onSubmit={logSession}><label htmlFor="manual-minutes">{tr("logEarlier")}</label><div><input id="manual-minutes" type="number" min="1" max="600" value={manualMinutes} onChange={(event) => setManualMinutes(Number(event.target.value))} /><span>{tr("minutes")}</span><button>{tr("addSession")}</button></div></form>
          </section>
        </div>
      </section>

      <section className="app-section settings-section" id="settings">
        <div className="section-intro"><div><p className="eyebrow">{tr("settingsKicker")}</p><h2>{tr("settingsTitle")}</h2></div></div>
        <div className="settings-grid">
          <section className="setting-card sync-card card">
            <div className="sync-heading"><div><span className="setting-icon inline" aria-hidden="true">↔</span><div><p className="eyebrow">{tr(syncAvailable ? "encryptedTagline" : SYNC_RELAY_CONFIGURED ? "syncNativeTagline" : "syncDesignTagline")}</p><h3>{tr("syncTitle")}</h3></div></div><span className={`sync-status ${syncStatus}`} role="status" aria-live="polite" aria-atomic="true">{syncStatusLabel}</span></div>
            <p>{tr("syncCopy")}</p>
            <p className="sync-scope">{tr("syncScope")}</p>
            {!syncAvailable ? <div className="browser-preview sync-disabled">
              <strong>{tr(SYNC_RELAY_CONFIGURED ? "syncNativeOnlyTitle" : "syncNotPublishedTitle")}</strong>
              <p>{tr(SYNC_RELAY_CONFIGURED ? "syncNativeOnlyCopy" : "syncRelayUnavailable")}</p>
              {syncConfig && <button className="secondary-button" disabled={syncBusy} onClick={disconnectPrivateSync}>{tr("disconnect")}</button>}
            </div> : syncConfig ? <div className="sync-connected">
              <label className="pairing-code"><span>{tr("syncCode")}</span><input id="pairing-code" type={showPairingCode ? "text" : "password"} readOnly value={pairingCode} spellCheck={false} autoComplete="off" aria-describedby="pairing-warning" /></label>
              <p className="sync-warning" id="pairing-warning"><span aria-hidden="true">ⓘ </span>{tr("syncCodeCopy")}</p>
              <div className="sync-actions"><button className="primary-button" disabled={syncBusy} onClick={manualSync}>{syncBusy ? tr("syncing") : tr("syncNow")}</button><button className="secondary-button" disabled={syncBusy} onClick={() => setShowPairingCode((visible) => !visible)} aria-controls="pairing-code" aria-pressed={showPairingCode}>{showPairingCode ? tr("hideCode") : tr("showCode")}</button><button className="secondary-button" disabled={syncBusy} onClick={copyPairingCode}>{tr("copyCode")}</button><button className="secondary-button" disabled={syncBusy} onClick={sharePairingCode}>{tr("shareCode")}</button></div>
              <p className="last-sync">{lastSyncedAt ? tr("lastSynced", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(lastSyncedAt)) }) : tr("lastSyncedNever")}</p>
              <div className="sync-danger"><button className="text-button" disabled={syncBusy} onClick={disconnectPrivateSync}>{tr("disconnect")}</button><button className="danger-link" disabled={syncBusy} onClick={removeEncryptedSyncCopy}>{tr("deleteRemote")}</button></div>
            </div> : <div className="sync-setup-shell"><button className="secondary-button sync-setup-toggle" type="button" aria-expanded={syncSetupOpen} aria-controls="sync-setup-options" onClick={() => setSyncSetupOpen((open) => !open)}>{syncSetupOpen ? tr("hideSyncSetup") : tr("setUpSync")}</button>{syncSetupOpen && <div className="sync-off-grid" id="sync-setup-options">
              <div className="sync-start"><h4>{tr("createSync")}</h4><p>{tr("createSyncCopy")}</p><button className="primary-button" disabled={syncBusy} onClick={createPrivateSync}>{syncBusy ? tr("syncing") : tr("createSync")}</button></div>
              <form className="sync-join" onSubmit={joinPrivateSync}><h4>{tr("joinSync")}</h4><p>{tr("joinCopy")}</p><label><span>{tr("joinCode")}</span><input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} autoCapitalize="none" autoCorrect="off" autoComplete="off" spellCheck={false} placeholder="AG1-…" /></label><small>{tr("mergeSummary", { sessions: activeSessions.length, tasks: activeTasks.length })}</small><button className="secondary-button" disabled={syncBusy || !joinCode.trim()}>{syncBusy ? tr("syncing") : tr("joinSync")}</button></form>
            </div>}</div>}
          </section>

          <section className="setting-card card"><span className="setting-icon" aria-hidden="true">♪</span><h3>{tr("experience")}</h3><p>{tr("experienceCopy")}</p><button className={notificationPermission === "granted" ? "secondary-button enabled" : "secondary-button"} onClick={enableNotifications}>{notificationPermission === "granted" ? tr("notifyOn") : tr("notifications")}</button><label className="select-field"><span>{tr("sound")}</span><select value={settings.tone} onChange={(event) => { const tone = event.target.value as Tone; setSettings((value) => ({ ...value, tone })); playTone(tone); }}><option value="chime">{tr("soundChime")}</option><option value="bell">{tr("soundBell")}</option><option value="soft">{tr("soundSoft")}</option></select></label><div className="language-row"><div><strong>{tr("languageSettings")}</strong><small>{tr("languageSettingsCopy")}</small></div><button className="secondary-button" onClick={() => setLanguage(language === "en" ? "zh" : "en")} aria-label={tr("switchLanguage")}>{tr("language")}</button></div><small className="shortcut-copy">{tr("shortcuts")}</small></section>
          <section className="setting-card local-card card"><span className="setting-icon" aria-hidden="true">⌂</span><h3>{tr("localData")}</h3><p>{nativeApp ? tr("nativeStorageCopy") : tr("browserStorageCopy")}</p><div className="data-status"><span className="local-dot" aria-hidden="true" />{nativeApp ? tr("nativeInstalled") : storageProtected ? tr("storageProtected") : tr("storageStandard")}</div><div className="button-grid">{!nativeApp && <button className="secondary-button" onClick={protectStorage}>{storageProtected ? "✓ " : ""}{tr("protectStorage")}</button>}<button className="secondary-button" onClick={exportJson}>↓ {tr("exportJson")}</button><button className="secondary-button" onClick={exportCsv}>↓ {tr("exportCsv")}</button><button className="secondary-button" onClick={() => importRef.current?.click()}>↑ {tr("restore")}</button><input ref={importRef} type="file" accept="application/json,.json" onChange={importData} hidden /></div><p className="backup-date">{lastBackupAt ? tr("lastBackup", { date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(lastBackupAt)) }) : tr("lastBackupNever")}</p>{nativeApp && <p className="uninstall-warning">{tr("uninstallWarning")}</p>}<button className="danger-link" onClick={clearAllData}>{tr("clearAll")}</button></section>
          <section className="setting-card install-card card">
            <span className="setting-icon" aria-hidden="true">↓</span>
            <h3>{tr("downloadAppsTitle")}</h3>
            <p>{nativeApp ? tr("nativeStorageCopy") : tr("downloadAppsCopy")}</p>
            {nativeApp ? <>
              <div className="install-success">✓ {tr("nativeInstalled")}</div>
              <p className="uninstall-warning">{tr("uninstallWarning")}</p>
            </> : <>
              <div className="download-grid">
                {downloadOptions.map((option) => {
                  const build = downloadBuilds[option.id];
                  return <article className="download-option" key={option.id}>
                    <div><strong>{tr(option.title)}</strong><p>{tr(option.detail)}</p></div>
                    {build ? <a className="download-link" href={build.href} download>{tr("downloadNow")}{build.size ? ` · ${build.size}` : ""}</a> : <span className="build-unavailable">{tr("buildUnavailable")}</span>}
                  </article>;
                })}
                <article className="download-option">
                  <div><strong>{tr("iosApp")}</strong><p>{tr("iosDetail")}</p></div>
                  <span className="build-unavailable">{tr("buildUnavailable")}</span>
                </article>
              </div>
              {releasePage && <a className="secondary-button release-page-link" href={releasePage} target="_blank" rel="noreferrer">{tr("viewGitHubRelease")}</a>}
              <div className="browser-preview">
                <strong>{tr("browserPreviewTitle")}</strong>
                <p>{tr("browserPreviewCopy")}</p>
              </div>
            </>}
          </section>
        </div>
        <p className="notice global-notice" aria-live="polite">{notice}</p>
      </section>

      <footer><span>{tr(nativeApp ? "privacyFooter" : "browserPreviewFooter")}</span></footer>

      <nav className="mobile-nav" aria-label={tr("primaryNavigation")}>
        {navItems.map((item) => <button key={item.id} className={activeSection === item.id ? "active" : ""} aria-current={activeSection === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><span aria-hidden="true">{item.icon}</span><small>{tr(item.label)}</small></button>)}
      </nav>

      {reflectionId !== null && <div className="modal-backdrop"><section className="modal-card reflection-card" role="dialog" aria-modal="true" aria-labelledby="reflection-title"><span className="modal-mark glow" aria-hidden="true">✦</span><h2 id="reflection-title">{tr("reflectionTitle")}</h2><p>{tr("reflectionCopy")}</p><label className="reflection-field"><span>{tr("finishedWhat")}</span><textarea value={reflectionNote} maxLength={300} onChange={(event) => setReflectionNote(event.target.value)} placeholder={tr("finishedPlaceholder")} /></label><fieldset><legend>{tr("focusQuality")}</legend><div className="rating-grid">{([1, 2, 3] as const).map((rating) => <label key={rating} className={reflectionRating === rating ? "selected" : ""}><input type="radio" name="rating" value={rating} checked={reflectionRating === rating} onChange={() => setReflectionRating(rating)} /><span>{rating === 1 ? tr("ratingLow") : rating === 2 ? tr("ratingMedium") : tr("ratingHigh")}</span></label>)}</div></fieldset><div className="modal-actions"><button className="primary-button" onClick={saveReflection}>{tr("saveReflection")}</button><button className="text-button" onClick={() => setReflectionId(null)}>{tr("skipReflection")}</button></div></section></div>}
    </main>
  );
}
