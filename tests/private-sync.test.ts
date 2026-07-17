import assert from "node:assert/strict";
import test from "node:test";
import {
  createPairingCode,
  deleteSyncRoom,
  decryptPayload,
  deriveLocator,
  encryptPayload,
  formatPairingCode,
  mergeSyncPayload,
  parsePairingCode,
  syncRound,
  SyncCipherError,
  SyncHttpError,
  SyncRollbackError,
  SyncRoomMissingError,
  type SyncPayload,
} from "../app/lib/private-sync.ts";

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    version: 1,
    generation: 0,
    tasks: [],
    sessions: [],
    preferences: {
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      dailyGoal: 120,
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("pairing codes round-trip a random room and root secret", async () => {
  const firstCode = await createPairingCode();
  const secondCode = await createPairingCode();
  assert.notEqual(firstCode, secondCode);
  assert.match(firstCode, /^AG1-[A-Za-z0-9_-]+$/u);

  const config = await parsePairingCode(firstCode);
  assert.equal(config.version, 1);
  assert.equal(config.highestAcceptedGeneration, 0);
  assert.equal(Buffer.from(config.roomId, "base64url").length, 16);
  assert.equal(Buffer.from(config.rootSecret, "base64url").length, 32);
  assert.equal(Buffer.from(await deriveLocator(config), "base64url").length, 32);
  assert.equal(await formatPairingCode({ ...config, highestAcceptedGeneration: 99 }), firstCode);
});

test("pairing codes reject a changed checksum", async () => {
  const code = await createPairingCode();
  const finalCharacter = code.at(-1);
  const changed = `${code.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
  await assert.rejects(parsePairingCode(changed), /checksum|base64url/u);
});

test("AES-GCM envelope round-trips a canonical payload and rejects a different room", async () => {
  const config = await parsePairingCode(await createPairingCode());
  const otherConfig = await parsePairingCode(await createPairingCode());
  const source = payload({
    generation: 7,
    tasks: [
      { id: "task-b", label: "Second", done: false, updatedAt: "2026-07-15T02:00:00.000Z" },
      { id: "task-a", label: "First", done: true, updatedAt: "2026-07-15T01:00:00.000Z" },
    ],
    sessions: [
      {
        id: "session-a",
        minutes: 25,
        completedAt: "2026-07-15T01:25:00.000Z",
        updatedAt: "2026-07-15T01:25:00.000Z",
      },
    ],
  });

  const encrypted = await encryptPayload(source, config);
  assert.equal(Buffer.from(encrypted.slice(0, 4)).toString("ascii"), "AGSY");
  assert.equal(encrypted[4], 1);
  const decrypted = await decryptPayload(encrypted, config);
  assert.deepEqual(
    decrypted.tasks.map((task) => task.id),
    ["task-a", "task-b"],
  );
  assert.deepEqual(decrypted, { ...source, tasks: [source.tasks[1], source.tasks[0]] });
  await assert.rejects(decryptPayload(encrypted, otherConfig));
});

test("merge is commutative, keeps newer records, and lets tombstones win timestamp ties", () => {
  const left = payload({
    generation: 2,
    tasks: [
      { id: "same", label: "old", done: false, updatedAt: "2026-07-15T01:00:00.000Z" },
      { id: "deleted", label: "remove", done: false, updatedAt: "2026-07-15T01:00:00.000Z" },
    ],
  });
  const right = payload({
    generation: 3,
    tasks: [
      { id: "same", label: "new", done: true, updatedAt: "2026-07-15T02:00:00.000Z" },
      {
        id: "deleted",
        label: "remove",
        done: false,
        updatedAt: "2026-07-15T01:00:00.000Z",
        deletedAt: "2026-07-15T01:00:00.000Z",
      },
    ],
  });

  const leftRight = mergeSyncPayload(left, right);
  const rightLeft = mergeSyncPayload(right, left);
  assert.deepEqual(leftRight, rightLeft);
  assert.equal(leftRight.generation, 3);
  assert.equal(leftRight.tasks.find((task) => task.id === "same")?.label, "new");
  assert.equal(
    leftRight.tasks.find((task) => task.id === "deleted")?.deletedAt,
    "2026-07-15T01:00:00.000Z",
  );
});

test("equal-timestamp divergent live records resolve deterministically", () => {
  const left = payload({
    tasks: [{ id: "task", label: "Alpha", done: false, updatedAt: "2026-07-15T01:00:00.000Z" }],
  });
  const right = payload({
    tasks: [{ id: "task", label: "Beta", done: false, updatedAt: "2026-07-15T01:00:00.000Z" }],
  });
  assert.deepEqual(mergeSyncPayload(left, right), mergeSyncPayload(right, left));
});

test("preferences use deterministic LWW and reject values outside bounded ranges", async () => {
  const older = payload();
  const newer = payload({
    preferences: {
      focusMinutes: 50,
      shortBreakMinutes: 10,
      longBreakMinutes: 30,
      dailyGoal: 240,
      updatedAt: "2026-07-15T02:00:00.000Z",
    },
  });
  assert.equal(mergeSyncPayload(older, newer).preferences.focusMinutes, 50);
  assert.deepEqual(mergeSyncPayload(older, newer), mergeSyncPayload(newer, older));

  const config = await parsePairingCode(await createPairingCode());
  await assert.rejects(
    encryptPayload(
      payload({ preferences: { ...older.preferences, focusMinutes: 0 } }),
      config,
    ),
    /focusMinutes/u,
  );
});

test("syncRound uses an opaque locator and retries one failed ETag write", async () => {
  const config = await parsePairingCode(await createPairingCode());
  const remote = payload({
    generation: 1,
    tasks: [{ id: "remote", label: "Remote", done: false, updatedAt: "2026-07-15T01:00:00.000Z" }],
  });
  const encryptedRemote = await encryptPayload(remote, config);
  let gets = 0;
  let puts = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.match(headers.get("authorization") ?? "", /^Afterglow [A-Za-z0-9_-]{43}$/u);
    if (init?.method === "GET") {
      gets += 1;
      return new Response(encryptedRemote.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { ETag: '"room-1"', "Content-Type": "application/octet-stream" },
      });
    }

    puts += 1;
    assert.equal(init?.method, "PUT");
    assert.equal(headers.get("content-type"), "application/octet-stream");
    assert.equal(headers.get("if-match"), '"room-1"');
    return puts === 1
      ? new Response(null, { status: 412 })
      : new Response(null, { status: 204, headers: { ETag: '"room-2"' } });
  }) as typeof fetch;

  const result = await syncRound(config, payload(), { fetchImpl });
  assert.equal(gets, 2);
  assert.equal(puts, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.payload.generation, 2);
  assert.equal(result.config.highestAcceptedGeneration, 2);
  assert.equal(result.payload.tasks[0]?.id, "remote");
});

test("syncRound rejects a missing room after a previously accepted generation", async () => {
  const config = {
    ...(await parsePairingCode(await createPairingCode())),
    highestAcceptedGeneration: 4,
  };
  const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
  await assert.rejects(syncRound(config, payload({ generation: 4 }), { fetchImpl }), SyncRollbackError);
});

test("join mode refuses to create a room for a valid but nonexistent code", async () => {
  const config = await parsePairingCode(await createPairingCode());
  const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
  await assert.rejects(
    syncRound(config, payload(), { fetchImpl, requireExisting: true }),
    SyncRoomMissingError,
  );
});

test("syncRound exposes relay HTTP status and rejects unauthenticated ciphertext", async () => {
  const config = await parsePairingCode(await createPairingCode());
  await assert.rejects(
    syncRound(config, payload(), { fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch }),
    (error: unknown) => error instanceof SyncHttpError && error.operation === "GET" && error.status === 401,
  );

  await assert.rejects(
    syncRound(config, payload(), {
      fetchImpl: (async () => new Response(Uint8Array.from([0x41, 0x47, 0x53, 0x59, 0x01, 0xff]).buffer, {
        status: 200,
        headers: { ETag: '"room"', "Content-Type": "application/octet-stream" },
      })) as typeof fetch,
    }),
    SyncCipherError,
  );
});

test("deleteSyncRoom sends only the locator capability", async () => {
  const config = await parsePairingCode(await createPairingCode());
  let called = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    called = true;
    assert.equal(input, "/api/private-sync");
    assert.equal(init?.method, "DELETE");
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Afterglow [A-Za-z0-9_-]{43}$/u);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  await deleteSyncRoom(config, { fetchImpl });
  assert.equal(called, true);
});
