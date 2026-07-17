import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { handlePrivateSync, type SyncObjectStore, type SyncPutOptions, type SyncStoredObject, type SyncStoredObjectBody } from "../worker/private-sync.ts";

const source = await readFile(new URL("../worker/private-sync.ts", import.meta.url), "utf8");
const relaySource = await readFile(new URL("../worker/sync-relay.ts", import.meta.url), "utf8");

test("private sync uses an opaque capability-derived storage key", () => {
  assert.match(source, /\/api\/private-sync/);
  assert.ok(source.includes("const AUTHORIZATION_PATTERN = /^Afterglow ([A-Za-z0-9_-]{43})$/;"));
  assert.match(source, /crypto\.subtle\.digest\("SHA-256", input\.buffer\)/);
  assert.match(source, /return `sync\/\$\{hex\}`/);
  assert.doesNotMatch(source, /authHash|manifest\.json|deviceId|ciphertext/);
});

test("private sync only accepts bounded conditional binary writes", () => {
  assert.match(source, /MAX_ENVELOPE_BYTES = 4 \* 1024 \* 1024/);
  assert.match(source, /application\/octet-stream/);
  assert.match(source, /If-Match/);
  assert.match(source, /If-None-Match/);
  assert.match(source, /onlyIf/);
  assert.match(source, /Write precondition failed/);
  assert.match(source, /status: 204/);
});

test("private sync responses disable caching and do not enable CORS", () => {
  assert.match(source, /Cache-Control", "no-store"/);
  assert.match(source, /Cross-Origin-Resource-Policy", "same-origin"/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin/i);
  assert.match(source, /if \(!object\) return errorResponse\(404/);
});

test("standalone relay exposes only the private-sync route", () => {
  assert.match(relaySource, /url\.pathname !== PRIVATE_SYNC_PATH/);
  assert.match(relaySource, /env\.SYNC_ROOMS\.getByName\(objectName\)\.fetch\(request\)/);
  assert.match(relaySource, /CHUNK_BYTES = 1024 \* 1024/);
  assert.match(relaySource, /transactionSync/);
  assert.doesNotMatch(relaySource, /R2Bucket|r2_buckets/);
  assert.doesNotMatch(relaySource, /vinext|ASSETS|IMAGES|Access-Control-Allow-Origin/i);
});

test("private sync creates, reads, conditionally updates, and deletes an encrypted envelope", async () => {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let version = 0;
  const store: SyncObjectStore = {
    async get(key): Promise<SyncStoredObjectBody | null> {
      const value = objects.get(key);
      if (!value) return null;
      return {
        etag: value.etag,
        httpEtag: `"${value.etag}"`,
        size: value.bytes.byteLength,
        body: new Blob([value.bytes]).stream() as ReadableStream<Uint8Array>,
      };
    },
    async put(key, input, options?: SyncPutOptions): Promise<SyncStoredObject | null> {
      const existing = objects.get(key);
      const createOnly = options?.onlyIf?.get("if-none-match") === "*";
      const expected = options?.onlyIf?.get("if-match");
      if ((createOnly && existing) || (expected && `"${existing?.etag ?? ""}"` !== expected)) return null;
      const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
      const etag = (++version).toString(16).padStart(32, "0");
      objects.set(key, { bytes, etag });
      return { etag, httpEtag: `"${etag}"`, size: bytes.byteLength };
    },
    async delete(key) {
      objects.delete(key);
    },
  };

  const endpoint = "https://sync.example.test/api/private-sync";
  const authorization = `Afterglow ${Buffer.alloc(32).toString("base64url")}`;
  const first = new Uint8Array([1, 2, 3, 4]);
  const create = await handlePrivateSync(new Request(endpoint, {
    method: "PUT",
    headers: { authorization, "content-type": "application/octet-stream", "if-none-match": "*" },
    body: first,
  }), store);
  assert.equal(create.status, 204);
  const firstEtag = create.headers.get("etag");
  assert.match(firstEtag ?? "", /^"[a-f0-9]{32}"$/);

  const read = await handlePrivateSync(new Request(endpoint, { headers: { authorization } }), store);
  assert.equal(read.status, 200);
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), first);
  assert.equal(read.headers.get("cache-control"), "no-store");
  assert.equal(read.headers.get("etag"), firstEtag);

  const second = new Uint8Array([9, 8, 7]);
  const update = await handlePrivateSync(new Request(endpoint, {
    method: "PUT",
    headers: { authorization, "content-type": "application/octet-stream", "if-match": firstEtag! },
    body: second,
  }), store);
  assert.equal(update.status, 204);
  assert.notEqual(update.headers.get("etag"), firstEtag);

  const stale = await handlePrivateSync(new Request(endpoint, {
    method: "PUT",
    headers: { authorization, "content-type": "application/octet-stream", "if-match": firstEtag! },
    body: first,
  }), store);
  assert.equal(stale.status, 412);

  const removed = await handlePrivateSync(new Request(endpoint, { method: "DELETE", headers: { authorization } }), store);
  assert.equal(removed.status, 204);
  const missing = await handlePrivateSync(new Request(endpoint, { headers: { authorization } }), store);
  assert.equal(missing.status, 404);
});
