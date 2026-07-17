import {
  errorResponse,
  handlePrivateSync,
  PRIVATE_SYNC_PATH,
  privateSyncObjectName,
  type SyncObjectStore,
  type SyncPutOptions,
  type SyncStoredObject,
  type SyncStoredObjectBody,
} from "./private-sync";

interface Env {
  SYNC_ROOMS: DurableObjectNamespace;
}

interface DurableObjectNamespace {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

interface SqlCursor<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>;
}

interface DurableObjectStorage {
  sql: SqlStorage;
  transactionSync<T>(callback: () => T): T;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface StoredMetadata {
  etag: string;
  size: number;
  chunk_count: number;
}

interface StoredChunk {
  data: ArrayBuffer | Uint8Array;
}

const CHUNK_BYTES = 1024 * 1024;

function normalizeChunk(value: ArrayBuffer | Uint8Array) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function assertOpaqueStorageKey(key: string) {
  if (!/^sync\/[a-f0-9]{64}$/.test(key)) throw new TypeError("Invalid private-sync storage key");
}

class DurableObjectSyncStore implements SyncObjectStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), etag TEXT NOT NULL, size INTEGER NOT NULL, chunk_count INTEGER NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS sync_chunks (chunk_index INTEGER PRIMARY KEY, data BLOB NOT NULL)");
  }

  async get(key: string): Promise<SyncStoredObjectBody | null> {
    assertOpaqueStorageKey(key);
    const metadata = this.storage.sql.exec<StoredMetadata>("SELECT etag, size, chunk_count FROM sync_state WHERE id = 1").toArray()[0];
    if (!metadata) return null;
    const rows = this.storage.sql.exec<StoredChunk>("SELECT data FROM sync_chunks ORDER BY chunk_index").toArray();
    if (rows.length !== metadata.chunk_count) throw new Error("Incomplete encrypted envelope");
    const chunks = rows.map((row) => normalizeChunk(row.data));
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (size !== metadata.size) throw new Error("Encrypted envelope size mismatch");
    return {
      etag: metadata.etag,
      httpEtag: `"${metadata.etag}"`,
      size,
      body: new Blob(chunks).stream() as ReadableStream<Uint8Array>,
    };
  }

  async put(key: string, input: ArrayBufferView, options?: SyncPutOptions): Promise<SyncStoredObject | null> {
    assertOpaqueStorageKey(key);
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      chunks.push(bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)));
    }
    const etag = crypto.randomUUID().replaceAll("-", "");

    return this.storage.transactionSync(() => {
      const existing = this.storage.sql.exec<StoredMetadata>("SELECT etag, size, chunk_count FROM sync_state WHERE id = 1").toArray()[0];
      const createOnly = options?.onlyIf?.get("if-none-match") === "*";
      const expected = options?.onlyIf?.get("if-match");
      if ((createOnly && existing) || (expected && `"${existing?.etag ?? ""}"` !== expected)) return null;

      this.storage.sql.exec("DELETE FROM sync_chunks");
      for (let index = 0; index < chunks.length; index += 1) {
        this.storage.sql.exec("INSERT INTO sync_chunks (chunk_index, data) VALUES (?, ?)", index, chunks[index]);
      }
      this.storage.sql.exec(
        "INSERT INTO sync_state (id, etag, size, chunk_count) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET etag = excluded.etag, size = excluded.size, chunk_count = excluded.chunk_count",
        etag,
        bytes.byteLength,
        chunks.length,
      );
      return { etag, httpEtag: `"${etag}"`, size: bytes.byteLength };
    });
  }

  async delete(key: string) {
    assertOpaqueStorageKey(key);
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM sync_chunks");
      this.storage.sql.exec("DELETE FROM sync_state");
    });
  }
}

export class SyncRoom {
  private readonly store: DurableObjectSyncStore;

  constructor(state: DurableObjectState) {
    this.store = new DurableObjectSyncStore(state.storage);
  }

  fetch(request: Request) {
    return handlePrivateSync(request, this.store);
  }
}

const relay = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== PRIVATE_SYNC_PATH) return errorResponse(404, "Not found");
    const objectName = await privateSyncObjectName(request.headers.get("authorization"));
    if (!objectName) return errorResponse(401, "Authorization required", { "WWW-Authenticate": "Afterglow" });
    return env.SYNC_ROOMS.getByName(objectName).fetch(request);
  },
};

export default relay;
