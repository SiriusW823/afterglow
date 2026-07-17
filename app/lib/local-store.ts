import { isNativeApp, readNativeValue, writeNativeValue } from "./native-runtime";

const DATABASE = "afterglow-local";
const STORE = "snapshots";
const SNAPSHOT_KEY = "current";
const FALLBACK_KEY = "afterglow-data";
const SYNC_CONFIG_KEY = "sync-config";
const SYNC_FALLBACK_KEY = "afterglow-private-sync";
const SYNC_LOCK_KEY = "sync-operation-lock";
const SYNC_LOCK_NAME = "afterglow-private-sync-connection";
const SYNC_LOCK_LEASE_MS = 30_000;
const NATIVE_SNAPSHOT_KEY = "snapshot";
const NATIVE_SYNC_CONFIG_KEY = "sync-config";
let writeQueue: Promise<void> = Promise.resolve();
let syncWriteQueue: Promise<void> = Promise.resolve();
let fallbackRealmQueue: Promise<void> = Promise.resolve();
let nativeRealmQueue: Promise<void> = Promise.resolve();
let activeFallbackLockToken: string | null = null;

type SyncStorageRecord<T = unknown> = {
  __afterglowSyncRecord: 1;
  revision: number;
  writeId: string;
  deleted: boolean;
  value?: T;
};

type SnapshotStorageRecord<T = unknown> = {
  __afterglowSnapshotRecord: 1;
  revision: number;
  writeId: string;
  deleted: boolean;
  value?: T;
};

export type SyncIdentity = { roomId: string; rootSecret: string };
export type SyncWriteOptions = { expectedIdentity?: SyncIdentity; requireEmpty?: boolean };

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

type SyncLockRecord = { token: string; expiresAt: number };

async function updateFallbackLock(token: string, operation: "acquire" | "renew" | "release") {
  const database = await openDatabase();
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(SYNC_LOCK_KEY);
    let changed = false;
    request.onsuccess = () => {
      const current = request.result as SyncLockRecord | undefined;
      const now = Date.now();
      if (operation === "acquire") {
        if (!current || current.expiresAt <= now || current.token === token) {
          store.put({ token, expiresAt: now + SYNC_LOCK_LEASE_MS } satisfies SyncLockRecord, SYNC_LOCK_KEY);
          changed = true;
        }
      } else if (operation === "renew") {
        if (current?.token === token) {
          store.put({ token, expiresAt: now + SYNC_LOCK_LEASE_MS } satisfies SyncLockRecord, SYNC_LOCK_KEY);
          changed = true;
        }
      } else if (current?.token === token) {
        store.delete(SYNC_LOCK_KEY);
        changed = true;
      }
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => {
      database.close();
      resolve(changed);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Afterglow local sync lock was aborted."));
    };
  });
}

async function withIndexedDbSyncLock<T>(action: () => Promise<T>) {
  const previousHolder = fallbackRealmQueue;
  let releaseRealmLock: () => void = () => undefined;
  fallbackRealmQueue = new Promise<void>((resolve) => { releaseRealmLock = resolve; });
  await previousHolder.catch(() => undefined);

  const token = newWriteId();
  const deadline = Date.now() + 12_000;
  try {
    while (!await updateFallbackLock(token, "acquire")) {
      if (Date.now() >= deadline) throw new Error("Another Afterglow tab is still updating sync settings.");
      await new Promise((resolve) => window.setTimeout(resolve, 40 + Math.floor(Math.random() * 80)));
    }
    const renewal = window.setInterval(() => void updateFallbackLock(token, "renew").catch(() => undefined), 10_000);
    activeFallbackLockToken = token;
    try {
      return await action();
    } finally {
      activeFallbackLockToken = null;
      window.clearInterval(renewal);
      await updateFallbackLock(token, "release").catch(() => undefined);
    }
  } finally {
    releaseRealmLock();
  }
}

export async function withLocalSyncLock<T>(action: () => Promise<T>) {
  if (isNativeApp()) {
    const previousHolder = nativeRealmQueue;
    let releaseRealmLock: () => void = () => undefined;
    nativeRealmQueue = new Promise<void>((resolve) => { releaseRealmLock = resolve; });
    await previousHolder.catch(() => undefined);
    try {
      return await action();
    } finally {
      releaseRealmLock();
    }
  }
  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(SYNC_LOCK_NAME, { mode: "exclusive" }, action);
  }
  return withIndexedDbSyncLock(action);
}

export async function assertLocalSyncLockOwnership() {
  if (isNativeApp()) return;
  const token = activeFallbackLockToken;
  if (!token) return;
  if (!await updateFallbackLock(token, "renew")) throw new Error("Afterglow lost its local sync lock.");
}

async function putIndexedRecord(key: string, value: unknown) {
  const database = await openDatabase();
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const fenceToken = activeFallbackLockToken;
    let written = false;
    const put = () => {
      const request = store.put(value, key);
      request.onsuccess = () => { written = true; };
      request.onerror = () => reject(request.error);
    };
    if (fenceToken) {
      const request = store.get(SYNC_LOCK_KEY);
      request.onsuccess = () => {
        const lock = request.result as SyncLockRecord | undefined;
        if (lock?.token === fenceToken && lock.expiresAt > Date.now()) put();
      };
      request.onerror = () => reject(request.error);
    } else {
      put();
    }
    transaction.oncomplete = () => {
      database.close();
      resolve(written);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Afterglow local write was aborted."));
    };
  });
}

function normaliseSnapshotRecord<T>(value: unknown): SnapshotStorageRecord<T> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const candidate = value as Partial<SnapshotStorageRecord<T>>;
    if (
      candidate.__afterglowSnapshotRecord === 1 &&
      Number.isSafeInteger(candidate.revision) &&
      Number(candidate.revision) >= 0 &&
      typeof candidate.writeId === "string" &&
      typeof candidate.deleted === "boolean"
    ) {
      return candidate as SnapshotStorageRecord<T>;
    }
  }
  return { __afterglowSnapshotRecord: 1, revision: 0, writeId: "legacy", deleted: false, value: value as T };
}

function compareSnapshotRecords(left: SnapshotStorageRecord | null, right: SnapshotStorageRecord | null) {
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  if (left.revision !== right.revision) return left.revision - right.revision;
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1;
  return left.writeId.localeCompare(right.writeId);
}

async function readSnapshotCandidates<T>() {
  let indexed: SnapshotStorageRecord<T> | null = null;
  let fallback: SnapshotStorageRecord<T> | null = null;
  try {
    const database = await openDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE, "readonly").objectStore(STORE).get(SNAPSHOT_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    indexed = normaliseSnapshotRecord<T>(value);
  } catch {
    // localStorage can remain available when IndexedDB is restricted.
  }
  try {
    fallback = normaliseSnapshotRecord<T>(JSON.parse(localStorage.getItem(FALLBACK_KEY) ?? "null"));
  } catch {
    // IndexedDB can remain available when localStorage is restricted.
  }
  return { indexed, fallback };
}

function newestSnapshotRecord<T>(indexed: SnapshotStorageRecord<T> | null, fallback: SnapshotStorageRecord<T> | null) {
  return compareSnapshotRecords(indexed, fallback) >= 0 ? indexed : fallback;
}

async function writeSnapshotRecord(record: SnapshotStorageRecord) {
  let writes = 0;
  try {
    if (await putIndexedRecord(SNAPSHOT_KEY, record)) writes += 1;
  } catch {
    // Web Locks can still fence a localStorage-only fallback.
  }
  if (writes > 0 || activeFallbackLockToken === null) {
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(record));
      writes += 1;
    } catch {
      // IndexedDB may still have accepted the same versioned record.
    }
  }
  return writes;
}

export async function readLocalSnapshot<T>() {
  if (typeof window === "undefined") return null;
  if (isNativeApp()) {
    const record = normaliseSnapshotRecord<T>(await readNativeValue(NATIVE_SNAPSHOT_KEY));
    return record && !record.deleted ? (record.value ?? null) : null;
  }
  const candidates = await readSnapshotCandidates<T>();
  const newest = newestSnapshotRecord(candidates.indexed, candidates.fallback);
  if (!newest) return null;
  return newest.deleted ? null : (newest.value ?? null);
}

async function persistSnapshot(value: unknown, deleted = false) {
  await withLocalSyncLock(async () => {
    if (isNativeApp()) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = normaliseSnapshotRecord(await readNativeValue(NATIVE_SNAPSHOT_KEY));
        const revision = (current?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error("Afterglow local data metadata is exhausted.");
        const record: SnapshotStorageRecord = {
          __afterglowSnapshotRecord: 1,
          revision,
          writeId: newWriteId(),
          deleted,
          ...(deleted ? {} : { value }),
        };
        await writeNativeValue(NATIVE_SNAPSHOT_KEY, record);
        const accepted = normaliseSnapshotRecord(await readNativeValue(NATIVE_SNAPSHOT_KEY));
        if (accepted?.revision === record.revision && accepted.writeId === record.writeId) return;
      }
      throw new Error(deleted ? "Afterglow could not clear native app data." : "Afterglow could not save native app data.");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await readSnapshotCandidates();
      const newest = newestSnapshotRecord(before.indexed, before.fallback);
      const revision = (newest?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Afterglow local data metadata is exhausted.");
      const record: SnapshotStorageRecord = {
        __afterglowSnapshotRecord: 1,
        revision,
        writeId: newWriteId(),
        deleted,
        ...(deleted ? {} : { value }),
      };
      if (await writeSnapshotRecord(record) === 0) continue;
      const after = await readSnapshotCandidates();
      const accepted = newestSnapshotRecord(after.indexed, after.fallback);
      if (accepted?.revision === record.revision && accepted.writeId === record.writeId) return;
    }
    throw new Error(deleted ? "Afterglow could not clear local data." : "Afterglow could not save local data.");
  });
}

export function writeLocalSnapshot(value: unknown) {
  writeQueue = writeQueue.then(() => persistSnapshot(value), () => persistSnapshot(value));
  return writeQueue;
}

export function clearLocalSnapshot() {
  writeQueue = writeQueue.then(() => persistSnapshot(null, true), () => persistSnapshot(null, true));
  return writeQueue;
}

function normaliseSyncRecord<T>(value: unknown): SyncStorageRecord<T> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") {
    const candidate = value as Partial<SyncStorageRecord<T>>;
    if (
      candidate.__afterglowSyncRecord === 1 &&
      Number.isSafeInteger(candidate.revision) &&
      Number(candidate.revision) >= 0 &&
      typeof candidate.writeId === "string" &&
      typeof candidate.deleted === "boolean"
    ) {
      return candidate as SyncStorageRecord<T>;
    }
  }
  // Version 1 migration: older releases stored the config object directly.
  return { __afterglowSyncRecord: 1, revision: 0, writeId: "legacy", deleted: false, value: value as T };
}

function compareSyncRecords(left: SyncStorageRecord | null, right: SyncStorageRecord | null) {
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  if (left.revision !== right.revision) return left.revision - right.revision;
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1;
  const leftGeneration = syncGeneration(left.value);
  const rightGeneration = syncGeneration(right.value);
  if (sameSyncIdentity(left.value, right.value) && leftGeneration !== rightGeneration) return leftGeneration - rightGeneration;
  return left.writeId.localeCompare(right.writeId);
}

function syncIdentity(value: unknown): SyncIdentity | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SyncIdentity>;
  return typeof candidate.roomId === "string" && typeof candidate.rootSecret === "string"
    ? { roomId: candidate.roomId, rootSecret: candidate.rootSecret }
    : null;
}

function sameSyncIdentity(left: unknown, right: unknown) {
  const leftIdentity = syncIdentity(left);
  const rightIdentity = syncIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity.roomId === rightIdentity.roomId && leftIdentity.rootSecret === rightIdentity.rootSecret);
}

function syncGeneration(value: unknown) {
  if (!value || typeof value !== "object") return 0;
  const generation = Number((value as { highestAcceptedGeneration?: unknown }).highestAcceptedGeneration);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

function preserveHighestGeneration(value: unknown, current: unknown) {
  if (!sameSyncIdentity(value, current) || !value || typeof value !== "object") return value;
  return { ...value, highestAcceptedGeneration: Math.max(syncGeneration(value), syncGeneration(current)) };
}

async function readSyncCandidates<T>() {
  let indexed: SyncStorageRecord<T> | null = null;
  let fallback: SyncStorageRecord<T> | null = null;
  let indexedAvailable = false;
  try {
    const database = await openDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE, "readonly").objectStore(STORE).get(SYNC_CONFIG_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    indexed = normaliseSyncRecord<T>(value);
    indexedAvailable = true;
    if (indexed) {
      try {
        localStorage.removeItem(SYNC_FALLBACK_KEY);
      } catch {
        // Any IndexedDB record, including a tombstone, supersedes the legacy mirror.
      }
    } else {
      try {
        const legacy = normaliseSyncRecord<T>(JSON.parse(localStorage.getItem(SYNC_FALLBACK_KEY) ?? "null"));
        // A legacy key is considered only while IndexedDB is available and truly empty.
        // The next fenced write migrates it to IndexedDB before removing this mirror.
        fallback = legacy && (legacy.deleted || syncIdentity(legacy.value)) ? legacy : null;
      } catch {
        // Invalid or inaccessible legacy data is never allowed to replace IndexedDB.
      }
    }
  } catch {
    // Encrypted sync pauses instead of falling back to a possibly stale key copy.
  }
  return { indexed, fallback, indexedAvailable };
}

function newestSyncRecord<T>(indexed: SyncStorageRecord<T> | null, fallback: SyncStorageRecord<T> | null) {
  return compareSyncRecords(indexed, fallback) >= 0 ? indexed : fallback;
}

export async function readLocalSyncConfig<T>() {
  if (typeof window === "undefined") return null;
  if (isNativeApp()) {
    const record = normaliseSyncRecord<T>(await readNativeValue(NATIVE_SYNC_CONFIG_KEY));
    return record && !record.deleted ? (record.value ?? null) : null;
  }
  const candidates = await readSyncCandidates<T>();
  if (!candidates.indexedAvailable) throw new Error("Afterglow encrypted sync storage is unavailable.");
  const newest = newestSyncRecord(candidates.indexed, candidates.fallback);
  return newest && !newest.deleted ? (newest.value ?? null) : null;
}

function newWriteId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function writeSyncRecord(record: SyncStorageRecord) {
  try {
    if (!await putIndexedRecord(SYNC_CONFIG_KEY, record)) return false;
    try {
      localStorage.removeItem(SYNC_FALLBACK_KEY);
    } catch {
      // The IndexedDB record is authoritative; this only removes a legacy mirror.
    }
    return true;
  } catch {
    return false;
  }
}

async function persistSyncState(value: unknown, deleted: boolean, options: SyncWriteOptions = {}) {
  if (!deleted && !options.requireEmpty && !options.expectedIdentity) {
    throw new Error("A sync write must either claim an empty slot or match the current connection.");
  }
  if (isNativeApp()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const newest = normaliseSyncRecord(await readNativeValue(NATIVE_SYNC_CONFIG_KEY));
      if (deleted && options.expectedIdentity && newest && !newest.deleted && !sameSyncIdentity(newest.value, options.expectedIdentity)) {
        throw new Error("Afterglow sync connection changed before it could be removed.");
      }
      if (!deleted && options.requireEmpty && newest && !newest.deleted) {
        throw new Error("Afterglow already has a sync connection on this device.");
      }
      if (!deleted && options.expectedIdentity) {
        if (!newest || newest.deleted || !sameSyncIdentity(newest.value, options.expectedIdentity)) {
          throw new Error("Afterglow sync connection changed on this device.");
        }
      }
      const revision = (newest?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Afterglow local sync metadata is exhausted.");
      const nextValue = deleted ? undefined : preserveHighestGeneration(value, newest?.value);
      const record: SyncStorageRecord = {
        __afterglowSyncRecord: 1,
        revision,
        writeId: newWriteId(),
        deleted,
        ...(deleted ? {} : { value: nextValue }),
      };
      await writeNativeValue(NATIVE_SYNC_CONFIG_KEY, record);
      const accepted = normaliseSyncRecord(await readNativeValue(NATIVE_SYNC_CONFIG_KEY));
      if (accepted?.revision === record.revision && accepted.writeId === record.writeId) return;
    }
    throw new Error(deleted
      ? "Afterglow could not remove the private sync key from this app."
      : "Afterglow could not persist the private sync key in this app.");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await readSyncCandidates();
    const newest = newestSyncRecord(before.indexed, before.fallback);
    if (deleted && options.expectedIdentity && newest && !newest.deleted && !sameSyncIdentity(newest.value, options.expectedIdentity)) {
      throw new Error("Afterglow sync connection changed before it could be removed.");
    }
    if (!deleted && options.requireEmpty && newest && !newest.deleted) {
      throw new Error("Afterglow already has a sync connection on this device.");
    }
    if (!deleted && options.expectedIdentity) {
      if (!newest || newest.deleted || !sameSyncIdentity(newest.value, options.expectedIdentity)) {
        throw new Error("Afterglow sync connection changed on this device.");
      }
    }
    const revision = (newest?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("Afterglow local sync metadata is exhausted.");
    const nextValue = deleted ? undefined : preserveHighestGeneration(value, newest?.value);
    const record: SyncStorageRecord = {
      __afterglowSyncRecord: 1,
      revision,
      writeId: newWriteId(),
      deleted,
      ...(deleted ? {} : { value: nextValue }),
    };
    if (!await writeSyncRecord(record)) continue;
    const after = await readSyncCandidates();
    const accepted = newestSyncRecord(after.indexed, after.fallback);
    if (accepted?.revision === record.revision && accepted.writeId === record.writeId) return;
  }
  throw new Error(deleted
    ? "Afterglow could not remove the private sync key from this device."
    : "Afterglow could not persist the private sync key on this device.");
}

async function persistSyncConfig(value: unknown, options: SyncWriteOptions) {
  await persistSyncState(value, false, options);
}

export function writeLocalSyncConfig(value: unknown, options: SyncWriteOptions) {
  syncWriteQueue = syncWriteQueue.then(() => persistSyncConfig(value, options), () => persistSyncConfig(value, options));
  return syncWriteQueue;
}

export function clearLocalSyncConfig(expectedIdentity: SyncIdentity) {
  syncWriteQueue = syncWriteQueue.then(
    () => persistSyncState(null, true, { expectedIdentity }),
    () => persistSyncState(null, true, { expectedIdentity }),
  );
  return syncWriteQueue;
}
