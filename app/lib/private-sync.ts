import type { FocusSession } from "./stats.ts";

const PAIRING_PREFIX = "AG1-";
const PAIRING_VERSION = 1;
const ROOM_ID_BYTES = 16;
const ROOT_SECRET_BYTES = 32;
const CHECKSUM_BYTES = 4;
const PAIRING_BYTES = 1 + ROOM_ID_BYTES + ROOT_SECRET_BYTES + CHECKSUM_BYTES;

const ENVELOPE_MAGIC = new Uint8Array([0x41, 0x47, 0x53, 0x59]); // AGSY
const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.length + 1 + IV_BYTES;
export const MAX_SYNC_ENVELOPE_BYTES = 4 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type SyncConfig = {
  version: 1;
  /** Base64url-encoded 16-byte random room identifier. */
  roomId: string;
  /** Base64url-encoded 32-byte root secret. Never send this value to the server. */
  rootSecret: string;
  /** Highest generation previously accepted from, or successfully written to, the room. */
  highestAcceptedGeneration: number;
};

export type SyncTask = {
  id: string;
  label: string;
  done: boolean;
  updatedAt: string;
  deletedAt?: string;
};

/**
 * FocusSession is the product's source of truth. Omit/redeclare the sync metadata
 * so this module also type-checks while older local data is being migrated.
 */
export type SyncSession = Omit<FocusSession, "id" | "updatedAt" | "deletedAt"> & {
  id: string;
  updatedAt: string;
  deletedAt?: string;
};

export type SyncPreferences = {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  /** Daily focused-minutes target. */
  dailyGoal: number;
  updatedAt: string;
};

export type SyncPayload = {
  version: 1;
  /** Monotonic room generation used to detect a server replay or rollback. */
  generation: number;
  tasks: SyncTask[];
  sessions: SyncSession[];
  /** Deliberately excludes language, sound, current intent, and an active timer. */
  preferences: SyncPreferences;
};

export type SyncRoundOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Includes the initial attempt. Defaults to three attempts. */
  maxAttempts?: number;
  /** Join flow safety: refuse to create a room when the supplied code has no remote object. */
  requireExisting?: boolean;
};

export type SyncRoundResult = {
  payload: SyncPayload;
  config: SyncConfig;
  etag: string;
  attempts: number;
};

export class SyncRollbackError extends Error {
  readonly expectedAtLeast: number;
  readonly received: number | null;

  constructor(expectedAtLeast: number, received: number | null) {
    super(
      received === null
        ? `Sync room disappeared after generation ${expectedAtLeast}.`
        : `Sync rollback detected: expected generation ${expectedAtLeast} or newer, received ${received}.`,
    );
    this.name = "SyncRollbackError";
    this.expectedAtLeast = expectedAtLeast;
    this.received = received;
  }
}

export class SyncConflictError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`Sync could not commit after ${attempts} conditional-write attempts.`);
    this.name = "SyncConflictError";
    this.attempts = attempts;
  }
}

export class SyncRoomMissingError extends Error {
  constructor() {
    super("The encrypted sync room does not exist.");
    this.name = "SyncRoomMissingError";
  }
}

export class SyncHttpError extends Error {
  readonly operation: "GET" | "PUT" | "DELETE";
  readonly status: number;

  constructor(operation: "GET" | "PUT" | "DELETE", status: number) {
    super(`Private sync ${operation} failed with HTTP ${status}.`);
    this.name = "SyncHttpError";
    this.operation = operation;
    this.status = status;
  }
}

export class SyncPayloadTooLargeError extends Error {
  readonly size: number;

  constructor(size: number) {
    super(`Encrypted sync snapshot is ${size} bytes; the limit is ${MAX_SYNC_ENVELOPE_BYTES} bytes.`);
    this.name = "SyncPayloadTooLargeError";
    this.size = size;
  }
}

export class SyncCipherError extends Error {
  constructor(cause?: unknown) {
    super("The encrypted sync snapshot could not be authenticated.", { cause });
    this.name = "SyncCipherError";
  }
}

type VersionedRecord = {
  id: string;
  updatedAt: string;
  deletedAt?: string;
};

type RemoteSnapshot =
  | { envelope: null; etag: null }
  | { envelope: Uint8Array; etag: string };

function cryptoApi() {
  const api = globalThis.crypto;
  if (!api?.subtle) throw new Error("Web Crypto is unavailable in this environment.");
  return api;
}

function concatBytes(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url value.");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid base64url value.");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytesToBase64Url(bytes) !== value) throw new Error("Invalid non-canonical base64url value.");
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function pairingChecksum(data: Uint8Array) {
  const domain = textEncoder.encode("afterglow/pairing-code/v1\0");
  const digest = await cryptoApi().subtle.digest("SHA-256", concatBytes(domain, data));
  return new Uint8Array(digest).slice(0, CHECKSUM_BYTES);
}

function decodeConfig(config: SyncConfig) {
  if (config.version !== PAIRING_VERSION) throw new Error("Unsupported sync configuration version.");
  if (!Number.isSafeInteger(config.highestAcceptedGeneration) || config.highestAcceptedGeneration < 0) {
    throw new Error("Invalid highest accepted generation.");
  }
  const roomId = base64UrlToBytes(config.roomId);
  const rootSecret = base64UrlToBytes(config.rootSecret);
  if (roomId.length !== ROOM_ID_BYTES) throw new Error("A sync room ID must contain 16 bytes.");
  if (rootSecret.length !== ROOT_SECRET_BYTES) throw new Error("A sync root secret must contain 32 bytes.");
  return { roomId, rootSecret };
}

/** Creates a copyable, checksummed code containing a random room ID and 256-bit root secret. */
export async function createPairingCode() {
  const random = new Uint8Array(ROOM_ID_BYTES + ROOT_SECRET_BYTES);
  cryptoApi().getRandomValues(random);
  return formatPairingCode({
    version: PAIRING_VERSION,
    roomId: bytesToBase64Url(random.slice(0, ROOM_ID_BYTES)),
    rootSecret: bytesToBase64Url(random.slice(ROOM_ID_BYTES)),
    highestAcceptedGeneration: 0,
  });
}

/** Rebuilds the same copyable pairing code from persisted client-side configuration. */
export async function formatPairingCode(config: SyncConfig) {
  const { roomId, rootSecret } = decodeConfig(config);
  const body = concatBytes(new Uint8Array([PAIRING_VERSION]), roomId, rootSecret);
  const checksum = await pairingChecksum(body);
  return `${PAIRING_PREFIX}${bytesToBase64Url(concatBytes(body, checksum))}`;
}

/** Parses and verifies a pairing code. Newly paired devices start with no accepted generation. */
export async function parsePairingCode(code: string): Promise<SyncConfig> {
  const normalized = code.trim();
  if (!normalized.startsWith(PAIRING_PREFIX)) throw new Error("Invalid Afterglow pairing code prefix.");
  const bytes = base64UrlToBytes(normalized.slice(PAIRING_PREFIX.length));
  if (bytes.length !== PAIRING_BYTES) throw new Error("Invalid Afterglow pairing code length.");

  const body = bytes.slice(0, -CHECKSUM_BYTES);
  const actualChecksum = bytes.slice(-CHECKSUM_BYTES);
  const expectedChecksum = await pairingChecksum(body);
  if (!equalBytes(actualChecksum, expectedChecksum)) throw new Error("Pairing code checksum mismatch.");
  if (body[0] !== PAIRING_VERSION) throw new Error("Unsupported pairing code version.");

  const roomId = body.slice(1, 1 + ROOM_ID_BYTES);
  const rootSecret = body.slice(1 + ROOM_ID_BYTES);
  return {
    version: PAIRING_VERSION,
    roomId: bytesToBase64Url(roomId),
    rootSecret: bytesToBase64Url(rootSecret),
    highestAcceptedGeneration: 0,
  };
}

async function deriveBits(config: SyncConfig, purpose: "encryption" | "locator") {
  const { roomId, rootSecret } = decodeConfig(config);
  const key = await cryptoApi().subtle.importKey("raw", rootSecret, "HKDF", false, ["deriveBits"]);
  const bits = await cryptoApi().subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: roomId,
      info: textEncoder.encode(`afterglow/private-sync/v1/${purpose}`),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function encryptionKey(config: SyncConfig) {
  return cryptoApi().subtle.importKey(
    "raw",
    await deriveBits(config, "encryption"),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A server-visible, room-specific capability derived independently from the encryption key. */
export async function deriveLocator(config: SyncConfig) {
  return bytesToBase64Url(await deriveBits(config, "locator"));
}

function additionalData(config: SyncConfig) {
  const { roomId } = decodeConfig(config);
  return concatBytes(textEncoder.encode("afterglow/private-sync/v1\0"), roomId);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Sync payload cannot contain a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Sync payload contains a value that JSON cannot encode.");
}

function timestampValue(value: string | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function recordClock(record: VersionedRecord) {
  return Math.max(timestampValue(record.updatedAt), timestampValue(record.deletedAt));
}

function compareRecords(left: VersionedRecord, right: VersionedRecord) {
  const clockDifference = recordClock(left) - recordClock(right);
  if (clockDifference !== 0) return clockDifference;

  const leftIsTombstone = typeof left.deletedAt === "string";
  const rightIsTombstone = typeof right.deletedAt === "string";
  if (leftIsTombstone !== rightIsTombstone) return leftIsTombstone ? 1 : -1;

  const leftCanonical = stableStringify(left);
  const rightCanonical = stableStringify(right);
  return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
}

function mergeRecords<T extends VersionedRecord>(left: T[], right: T[]) {
  const merged = new Map<string, T>();
  for (const record of [...left, ...right]) {
    const current = merged.get(record.id);
    if (!current || compareRecords(record, current) > 0) merged.set(record.id, record);
  }
  return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function assertRecordMetadata(record: unknown, kind: string): asserts record is VersionedRecord {
  if (!record || typeof record !== "object") throw new Error(`Invalid ${kind} record.`);
  const candidate = record as Record<string, unknown>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) throw new Error(`Invalid ${kind} ID.`);
  if (typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt))) {
    throw new Error(`Invalid ${kind} updatedAt timestamp.`);
  }
  if (
    candidate.deletedAt !== undefined &&
    (typeof candidate.deletedAt !== "string" || Number.isNaN(Date.parse(candidate.deletedAt)))
  ) {
    throw new Error(`Invalid ${kind} deletedAt timestamp.`);
  }
}

function assertPayload(value: unknown): asserts value is SyncPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid sync payload.");
  const payload = value as Record<string, unknown>;
  if (payload.version !== 1) throw new Error("Unsupported sync payload version.");
  if (!Number.isSafeInteger(payload.generation) || (payload.generation as number) < 0) {
    throw new Error("Invalid sync payload generation.");
  }
  if (!Array.isArray(payload.tasks) || !Array.isArray(payload.sessions)) {
    throw new Error("Invalid sync payload collections.");
  }
  for (const task of payload.tasks) {
    assertRecordMetadata(task, "task");
    const candidate = task as Record<string, unknown>;
    if (typeof candidate.label !== "string" || typeof candidate.done !== "boolean") {
      throw new Error("Invalid task contents.");
    }
  }
  for (const session of payload.sessions) {
    assertRecordMetadata(session, "session");
    const candidate = session as Record<string, unknown>;
    if (
      typeof candidate.minutes !== "number" ||
      !Number.isFinite(candidate.minutes) ||
      typeof candidate.completedAt !== "string" ||
      Number.isNaN(Date.parse(candidate.completedAt))
    ) {
      throw new Error("Invalid session contents.");
    }
  }
  assertPreferences(payload.preferences);
}

function assertIntegerRange(value: unknown, name: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function assertPreferences(value: unknown): asserts value is SyncPreferences {
  if (!value || typeof value !== "object") throw new Error("Invalid sync preferences.");
  const preferences = value as Record<string, unknown>;
  assertIntegerRange(preferences.focusMinutes, "focusMinutes", 1, 180);
  assertIntegerRange(preferences.shortBreakMinutes, "shortBreakMinutes", 1, 60);
  assertIntegerRange(preferences.longBreakMinutes, "longBreakMinutes", 1, 90);
  assertIntegerRange(preferences.dailyGoal, "dailyGoal", 5, 600);
  if (typeof preferences.updatedAt !== "string" || Number.isNaN(Date.parse(preferences.updatedAt))) {
    throw new Error("Invalid sync preferences updatedAt timestamp.");
  }
}

function comparePreferences(left: SyncPreferences, right: SyncPreferences) {
  const timestampDifference = timestampValue(left.updatedAt) - timestampValue(right.updatedAt);
  if (timestampDifference !== 0) return timestampDifference;
  const leftCanonical = stableStringify(left);
  const rightCanonical = stableStringify(right);
  return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
}

function mergePreferences(left: SyncPreferences, right: SyncPreferences) {
  return comparePreferences(left, right) >= 0 ? left : right;
}

function canonicalPayload(payload: SyncPayload): SyncPayload {
  assertPayload(payload);
  return {
    version: 1,
    generation: payload.generation,
    tasks: mergeRecords([], payload.tasks),
    sessions: mergeRecords([], payload.sessions),
    preferences: { ...payload.preferences },
  };
}

/** Deterministic last-write-wins merge. Tombstones win exact timestamp ties. */
export function mergeSyncPayload(left: SyncPayload, right: SyncPayload): SyncPayload {
  assertPayload(left);
  assertPayload(right);
  return {
    version: 1,
    generation: Math.max(left.generation, right.generation),
    tasks: mergeRecords(left.tasks, right.tasks),
    sessions: mergeRecords(left.sessions, right.sessions),
    preferences: { ...mergePreferences(left.preferences, right.preferences) },
  };
}

/** Encrypts a canonical payload into the binary AGSY v1 envelope. */
export async function encryptPayload(payload: SyncPayload, config: SyncConfig): Promise<Uint8Array> {
  const canonical = canonicalPayload(payload);
  const iv = new Uint8Array(IV_BYTES);
  cryptoApi().getRandomValues(iv);
  const ciphertext = await cryptoApi().subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(config), tagLength: 128 },
    await encryptionKey(config),
    textEncoder.encode(stableStringify(canonical)),
  );
  return concatBytes(
    ENVELOPE_MAGIC,
    new Uint8Array([ENVELOPE_VERSION]),
    iv,
    new Uint8Array(ciphertext),
  );
}

/** Authenticates, decrypts, validates, and canonicalizes an AGSY v1 envelope. */
export async function decryptPayload(
  envelope: ArrayBuffer | Uint8Array,
  config: SyncConfig,
): Promise<SyncPayload> {
  const bytes = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  if (bytes.length < ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES) throw new Error("Encrypted sync envelope is truncated.");
  if (!equalBytes(bytes.slice(0, ENVELOPE_MAGIC.length), ENVELOPE_MAGIC)) {
    throw new Error("Invalid encrypted sync envelope magic.");
  }
  if (bytes[ENVELOPE_MAGIC.length] !== ENVELOPE_VERSION) {
    throw new Error("Unsupported encrypted sync envelope version.");
  }

  const ivStart = ENVELOPE_MAGIC.length + 1;
  const iv = bytes.slice(ivStart, ivStart + IV_BYTES);
  const ciphertext = bytes.slice(ENVELOPE_HEADER_BYTES);
  const plaintext = await cryptoApi().subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(config), tagLength: 128 },
    await encryptionKey(config),
    ciphertext,
  );
  const parsed: unknown = JSON.parse(textDecoder.decode(plaintext));
  assertPayload(parsed);
  return canonicalPayload(parsed);
}

async function readRemote(
  endpoint: string,
  locator: string,
  fetchImpl: typeof fetch,
): Promise<RemoteSnapshot> {
  const response = await fetchImpl(endpoint, {
    method: "GET",
    cache: "no-store",
    headers: { Authorization: `Afterglow ${locator}` },
  });
  if (response.status === 404 || response.status === 204) return { envelope: null, etag: null };
  if (!response.ok) throw new SyncHttpError("GET", response.status);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("Private sync GET response is missing an ETag.");
  return { envelope: new Uint8Array(await response.arrayBuffer()), etag };
}

/**
 * Performs one optimistic encrypted sync transaction. A 412 response causes a
 * bounded GET/merge/re-encrypt/PUT retry; no secret key material crosses the wire.
 */
export async function syncRound(
  config: SyncConfig,
  localPayload: SyncPayload,
  options: SyncRoundOptions = {},
): Promise<SyncRoundResult> {
  decodeConfig(config);
  let workingPayload = canonicalPayload(localPayload);
  let highestAccepted = Math.max(config.highestAcceptedGeneration, workingPayload.generation);
  const endpoint = options.endpoint ?? "/api/private-sync";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 3;
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this environment.");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("maxAttempts must be an integer from 1 through 10.");
  }

  const locator = await deriveLocator(config);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remoteResult = await readRemote(endpoint, locator, fetchImpl);
    let remotePayload: SyncPayload | null = null;
    let etag = remoteResult.etag;

    if (remoteResult.envelope) {
      try {
        remotePayload = await decryptPayload(remoteResult.envelope, config);
      } catch (error) {
        throw new SyncCipherError(error);
      }
      if (remotePayload.generation < highestAccepted) {
        throw new SyncRollbackError(highestAccepted, remotePayload.generation);
      }
      highestAccepted = Math.max(highestAccepted, remotePayload.generation);
      workingPayload = mergeSyncPayload(workingPayload, remotePayload);
    } else if (options.requireExisting) {
      throw new SyncRoomMissingError();
    } else if (highestAccepted > 0) {
      throw new SyncRollbackError(highestAccepted, null);
    }

    const candidate: SyncPayload = {
      ...workingPayload,
      generation: highestAccepted + 1,
    };
    const encrypted = await encryptPayload(candidate, config);
    if (encrypted.byteLength > MAX_SYNC_ENVELOPE_BYTES) throw new SyncPayloadTooLargeError(encrypted.byteLength);
    const response = await fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Afterglow ${locator}`,
        "Content-Type": "application/octet-stream",
        ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
      },
      body: copyArrayBuffer(encrypted),
    });

    if (response.status === 412) {
      workingPayload = candidate;
      // candidate.generation was never accepted; retain only its merged records.
      workingPayload = { ...workingPayload, generation: highestAccepted };
      continue;
    }
    if (!response.ok) throw new SyncHttpError("PUT", response.status);
    etag = response.headers.get("etag");
    if (!etag) throw new Error("Private sync PUT response is missing an ETag.");

    return {
      payload: candidate,
      config: { ...config, highestAcceptedGeneration: candidate.generation },
      etag,
      attempts: attempt,
    };
  }

  throw new SyncConflictError(maxAttempts);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Permanently removes the server's opaque encrypted object for this room capability. */
export async function deleteSyncRoom(
  config: SyncConfig,
  options: Pick<SyncRoundOptions, "endpoint" | "fetchImpl"> = {},
): Promise<void> {
  decodeConfig(config);
  const endpoint = options.endpoint ?? "/api/private-sync";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this environment.");
  const locator = await deriveLocator(config);
  const response = await fetchImpl(endpoint, {
    method: "DELETE",
    headers: { Authorization: `Afterglow ${locator}` },
  });
  if (!response.ok) throw new SyncHttpError("DELETE", response.status);
}
