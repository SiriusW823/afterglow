import assert from "node:assert/strict";
import packageMetadata from "../package.json" with { type: "json" };
import {
  createPairingCode,
  deleteSyncRoom,
  parsePairingCode,
  syncRound,
  type SyncConfig,
  type SyncPayload,
} from "../app/lib/private-sync.ts";

const endpoint = process.argv[2] ?? packageMetadata.afterglow.syncEndpoint;
const url = new URL(endpoint);
if (url.protocol !== "https:" || url.pathname !== "/api/private-sync" || url.username || url.password || url.search || url.hash) {
  throw new TypeError("Expected one HTTPS /api/private-sync endpoint.");
}

async function verifyChunkedEnvelope() {
  const locator = crypto.getRandomValues(new Uint8Array(32));
  const authorization = `Afterglow ${Buffer.from(locator).toString("base64url")}`;
  const bytes = Buffer.allocUnsafe(3 * 1024 * 1024);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 17) % 256;

  try {
    const created = await fetch(endpoint, {
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/octet-stream",
        "if-none-match": "*",
      },
      body: bytes,
    });
    assert.equal(created.status, 204);
    const read = await fetch(endpoint, { headers: { authorization } });
    assert.equal(read.status, 200);
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
  } finally {
    await fetch(endpoint, { method: "DELETE", headers: { authorization } });
  }
}

const now = new Date().toISOString();
const preferences = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  dailyGoal: 60,
  updatedAt: now,
};
const deviceA: SyncPayload = {
  version: 1,
  generation: 0,
  tasks: [{ id: "live-device-a", label: "Live relay test A", done: false, updatedAt: now }],
  sessions: [],
  preferences,
};
const deviceB: SyncPayload = {
  version: 1,
  generation: 0,
  tasks: [{ id: "live-device-b", label: "Live relay test B", done: false, updatedAt: now }],
  sessions: [],
  preferences,
};

let cleanupConfig: SyncConfig | null = null;
try {
  await verifyChunkedEnvelope();
  const pairingCode = await createPairingCode();
  const configA = await parsePairingCode(pairingCode);
  const first = await syncRound(configA, deviceA, { endpoint });
  cleanupConfig = first.config;
  assert.deepEqual(first.payload.tasks.map((task) => task.id), ["live-device-a"]);

  const configB = await parsePairingCode(pairingCode);
  const joined = await syncRound(configB, deviceB, { endpoint, requireExisting: true });
  cleanupConfig = joined.config;
  assert.deepEqual(joined.payload.tasks.map((task) => task.id).sort(), ["live-device-a", "live-device-b"]);

  const changedAt = new Date(Date.now() + 1_000).toISOString();
  const changedOnB: SyncPayload = {
    ...joined.payload,
    tasks: joined.payload.tasks.map((task) => task.id === "live-device-a" ? { ...task, done: true, updatedAt: changedAt } : task),
  };
  const updated = await syncRound(joined.config, changedOnB, { endpoint, requireExisting: true });
  cleanupConfig = updated.config;

  const returnedToA = await syncRound(first.config, first.payload, { endpoint, requireExisting: true });
  cleanupConfig = returnedToA.config;
  assert.equal(returnedToA.payload.tasks.find((task) => task.id === "live-device-a")?.done, true);
  assert.ok(returnedToA.payload.generation >= 4);

  console.log(JSON.stringify({
    endpoint: url.origin,
    devices: 2,
    mergedTasks: returnedToA.payload.tasks.length,
    generation: returnedToA.payload.generation,
    encryptedRoundTrip: true,
    chunkedEnvelopeMiB: 3,
  }, null, 2));
} finally {
  if (cleanupConfig) await deleteSyncRoom(cleanupConfig, { endpoint });
}
