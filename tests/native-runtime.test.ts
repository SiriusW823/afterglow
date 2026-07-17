import assert from "node:assert/strict";
import test from "node:test";
import type { HttpOptions, HttpResponse } from "@capacitor/core";
import { capacitorSyncFetch, nativeSyncOptions, NATIVE_SYNC_ENDPOINT, SYNC_RELAY_CONFIGURED } from "../app/lib/native-runtime.ts";

type HttpMock = { request(options: HttpOptions): Promise<HttpResponse> };

function base64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

test("release code accepts only the configured production relay and keeps browser preview transport disabled", () => {
  assert.equal(SYNC_RELAY_CONFIGURED, true);
  assert.equal(NATIVE_SYNC_ENDPOINT, "https://afterglow-private-sync.sirius823935.workers.dev/api/private-sync");
  assert.deepEqual(nativeSyncOptions(), {});
});

test("Capacitor sync sends encrypted bytes as file base64 without UTF-8 conversion", async () => {
  const encrypted = Uint8Array.from([0x41, 0x47, 0x53, 0x59, 0x00, 0x7f, 0x80, 0x9f, 0xc3, 0xff]);
  let captured!: HttpOptions;
  const http: HttpMock = {
    async request(options) {
      captured = options;
      return { status: 204, data: "", headers: { etag: '"0123456789abcdef0123456789abcdef"' }, url: options.url };
    },
  };

  const response = await capacitorSyncFetch(NATIVE_SYNC_ENDPOINT, {
    method: "PUT",
    headers: {
      Authorization: `Afterglow ${"A".repeat(43)}`,
      "Content-Type": "application/octet-stream",
      "If-None-Match": "*",
    },
    body: encrypted.slice().buffer as ArrayBuffer,
  }, http);

  assert.equal(response.status, 204);
  assert.equal(captured?.data, base64(encrypted));
  assert.equal(captured?.dataType, "file");
  assert.equal(captured?.responseType, "arraybuffer");
  assert.equal(captured?.disableRedirects, true);
});

test("Capacitor sync reconstructs an octet-stream response byte for byte", async () => {
  const encrypted = Uint8Array.from([0x00, 0x80, 0x81, 0xfe, 0xff, 0x0a, 0x41]);
  const http: HttpMock = {
    async request(options) {
      return {
        status: 200,
        data: base64(encrypted),
        headers: { "content-type": "application/octet-stream", etag: '"0123456789abcdef0123456789abcdef"' },
        url: options.url,
      };
    },
  };

  const response = await capacitorSyncFetch(NATIVE_SYNC_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Afterglow ${"A".repeat(43)}` },
  }, http);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), encrypted);
});

test("Capacitor sync preserves JSON error responses and rejects malformed binary base64", async () => {
  const unauthorized = await capacitorSyncFetch(NATIVE_SYNC_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Afterglow ${"A".repeat(43)}` },
  }, {
    async request(options) {
      return { status: 401, data: { error: "Authorization required" }, headers: { "content-type": "application/json" }, url: options.url };
    },
  });
  assert.equal(await unauthorized.text(), JSON.stringify({ error: "Authorization required" }));

  await assert.rejects(capacitorSyncFetch(NATIVE_SYNC_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Afterglow ${"A".repeat(43)}` },
  }, {
    async request(options) {
      return { status: 200, data: "not base64", headers: { "content-type": "application/octet-stream" }, url: options.url };
    },
  }), /malformed base64/u);
});
