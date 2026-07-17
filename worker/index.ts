/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  SYNC_STORE: R2Bucket;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface R2Object {
  etag: string;
  httpEtag?: string;
  size: number;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
}

interface R2PutOptions {
  onlyIf?: Headers;
  httpMetadata?: { contentType?: string };
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: ArrayBufferView, options?: R2PutOptions): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const PRIVATE_SYNC_PATH = "/api/private-sync";
const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const AUTHORIZATION_PATTERN = /^Afterglow ([A-Za-z0-9_-]{43})$/;

function secureHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function errorResponse(status: number, message: string, extraHeaders?: HeadersInit) {
  return Response.json({ error: message }, {
    status,
    headers: secureHeaders(extraHeaders),
  });
}

function decodeLocator(authorization: string | null) {
  const match = authorization?.match(AUTHORIZATION_PATTERN);
  if (!match) return null;

  try {
    const encoded = match[1];
    const decoded = atob(`${encoded.replaceAll("-", "+").replaceAll("_", "/")}=`);
    if (decoded.length !== 32) return null;
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    return canonical === encoded ? bytes : null;
  } catch {
    return null;
  }
}

async function privateSyncKey(locatorBytes: Uint8Array) {
  const input = new Uint8Array(locatorBytes.byteLength);
  input.set(locatorBytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sync/${hex}`;
}

async function readEnvelope(request: Request) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return { status: 400, body: null } as const;
    if (Number(declaredLength) > MAX_ENVELOPE_BYTES) return { status: 413, body: null } as const;
  }
  if (!request.body) return { status: 400, body: null } as const;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ENVELOPE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { status: 413, body: null } as const;
    }
    chunks.push(value);
  }
  if (length === 0) return { status: 400, body: null } as const;

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: 200, body } as const;
}

function objectEtag(object: R2Object) {
  return object.httpEtag ?? `"${object.etag.replaceAll('"', "")}"`;
}

export async function handlePrivateSync(request: Request, store: R2Bucket): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
    return errorResponse(405, "Method not allowed", { Allow: "GET, PUT, DELETE" });
  }

  const locator = decodeLocator(request.headers.get("authorization"));
  if (!locator) return errorResponse(401, "Authorization required", { "WWW-Authenticate": "Afterglow" });
  const key = await privateSyncKey(locator);

  try {
    if (request.method === "GET") {
      const object = await store.get(key);
      if (!object) return errorResponse(404, "Not found");
      return new Response(object.body, {
        status: 200,
        headers: secureHeaders({
          "Content-Type": "application/octet-stream",
          "Content-Length": String(object.size),
          ETag: objectEtag(object),
        }),
      });
    }

    if (request.method === "DELETE") {
      await store.delete(key);
      return new Response(null, { status: 204, headers: secureHeaders() });
    }

    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
    if (contentType !== "application/octet-stream" || (contentEncoding && contentEncoding !== "identity")) {
      return errorResponse(415, "Binary envelope required");
    }

    const ifMatch = request.headers.get("if-match");
    const ifNoneMatch = request.headers.get("if-none-match");
    if ((!ifMatch && !ifNoneMatch) || (ifMatch && ifNoneMatch)) {
      return errorResponse(428, "Exactly one write precondition is required");
    }
    if (ifNoneMatch !== null && ifNoneMatch !== "*") {
      return errorResponse(400, "Invalid If-None-Match precondition");
    }
    if (ifMatch !== null && !/^"[A-Fa-f0-9]{32}"$/.test(ifMatch)) {
      return errorResponse(400, "Invalid If-Match precondition");
    }

    const envelope = await readEnvelope(request);
    if (!envelope.body) {
      return errorResponse(envelope.status, envelope.status === 413 ? "Envelope too large" : "Envelope required");
    }

    const onlyIf = new Headers();
    if (ifMatch) onlyIf.set("If-Match", ifMatch);
    else onlyIf.set("If-None-Match", "*");
    const stored = await store.put(key, envelope.body, {
      onlyIf,
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (!stored) return errorResponse(412, "Write precondition failed");
    return new Response(null, {
      status: 204,
      headers: secureHeaders({ ETag: objectEtag(stored) }),
    });
  } catch {
    return errorResponse(500, "Storage unavailable");
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === PRIVATE_SYNC_PATH) {
      return handlePrivateSync(request, env.SYNC_STORE);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
