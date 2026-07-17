import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

test("private sync uses an opaque capability-derived R2 key", () => {
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
