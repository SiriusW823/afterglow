export interface SyncStoredObject {
  etag: string;
  httpEtag?: string;
  size: number;
}

export interface SyncStoredObjectBody extends SyncStoredObject {
  body: ReadableStream<Uint8Array>;
}

export interface SyncPutOptions {
  onlyIf?: Headers;
  httpMetadata?: { contentType?: string };
}

export interface SyncObjectStore {
  get(key: string): Promise<SyncStoredObjectBody | null>;
  put(key: string, value: ArrayBufferView, options?: SyncPutOptions): Promise<SyncStoredObject | null>;
  delete(key: string): Promise<void>;
}

export const PRIVATE_SYNC_PATH = "/api/private-sync";
export const MAX_ENVELOPE_BYTES = 4 * 1024 * 1024;
const AUTHORIZATION_PATTERN = /^Afterglow ([A-Za-z0-9_-]{43})$/;

export function secureHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export function errorResponse(status: number, message: string, extraHeaders?: HeadersInit) {
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

export async function privateSyncObjectName(authorization: string | null) {
  const locator = decodeLocator(authorization);
  return locator ? privateSyncKey(locator) : null;
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

function objectEtag(object: SyncStoredObject) {
  return object.httpEtag ?? `"${object.etag.replaceAll('"', "")}"`;
}

export async function handlePrivateSync(request: Request, store: SyncObjectStore): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
    return errorResponse(405, "Method not allowed", { Allow: "GET, PUT, DELETE" });
  }

  const key = await privateSyncObjectName(request.headers.get("authorization"));
  if (!key) return errorResponse(401, "Authorization required", { "WWW-Authenticate": "Afterglow" });

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
