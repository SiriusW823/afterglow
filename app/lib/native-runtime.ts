import { Capacitor, CapacitorHttp, type HttpOptions, type HttpResponse } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import packageMetadata from "../../package.json" with { type: "json" };

export type NativePlatform = "web" | "windows" | "linux" | "macos" | "android" | "ios";

type DesktopFetchRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
};

type DesktopFetchResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
};

type CapacitorHttpClient = {
  request(options: HttpOptions): Promise<HttpResponse>;
};

type AfterglowDesktopBridge = {
  platform: "win32" | "linux" | "darwin";
  storage: {
    read(key: string): Promise<unknown | null>;
    write(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  sync: {
    fetch(request: DesktopFetchRequest): Promise<DesktopFetchResponse>;
  };
};

declare global {
  interface Window {
    afterglowDesktop?: AfterglowDesktopBridge;
  }
}

const NATIVE_TIMER_NOTIFICATION_ID = 1_964_072_015;
const NATIVE_STORAGE_LIMITS = Object.freeze({ snapshot: 16 * 1024 * 1024, "sync-config": 64 * 1024 });
const configuredSyncEndpoint = packageMetadata.afterglow.syncEndpoint;
const validSyncEndpoint = (() => {
  try {
    const url = new URL(configuredSyncEndpoint);
    return url.protocol === "https:" && url.pathname === "/api/private-sync" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
})();
export const SYNC_RELAY_CONFIGURED = packageMetadata.afterglow.syncRelayConfigured === true && validSyncEndpoint;
export const NATIVE_SYNC_ENDPOINT = configuredSyncEndpoint;

function desktopBridge() {
  return typeof window === "undefined" ? undefined : window.afterglowDesktop;
}

export function nativePlatform(): NativePlatform {
  const desktop = desktopBridge();
  if (desktop?.platform === "win32") return "windows";
  if (desktop?.platform === "linux") return "linux";
  if (desktop?.platform === "darwin") return "macos";
  if (typeof window !== "undefined" && Capacitor.isNativePlatform()) {
    const platform = Capacitor.getPlatform();
    if (platform === "android" || platform === "ios") return platform;
  }
  return "web";
}

export function isNativeApp() {
  return nativePlatform() !== "web";
}

export function isMobileNativeApp() {
  const platform = nativePlatform();
  return platform === "android" || platform === "ios";
}

function nativeStoragePath(key: string) {
  if (!Object.hasOwn(NATIVE_STORAGE_LIMITS, key)) throw new TypeError("Unsupported native storage key.");
  return `afterglow/${key}.json`;
}

function assertNativeStorageSize(key: string, json: string) {
  const limit = NATIVE_STORAGE_LIMITS[key as keyof typeof NATIVE_STORAGE_LIMITS];
  if (!limit || new TextEncoder().encode(json).byteLength > limit) throw new RangeError("Native storage value is too large.");
}

function isMissingNativeFile(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "OS-PLUG-FILE-0008");
}

export async function readNativeValue<T>(key: string): Promise<T | null> {
  const desktop = desktopBridge();
  if (desktop) return await desktop.storage.read(key) as T | null;
  if (isMobileNativeApp()) {
    try {
      const { data } = await Filesystem.readFile({
        path: nativeStoragePath(key),
        directory: Directory.LibraryNoCloud,
        encoding: Encoding.UTF8,
      });
      if (typeof data !== "string") throw new Error("Native JSON storage returned a non-text value.");
      assertNativeStorageSize(key, data);
      return JSON.parse(data) as T;
    } catch (error) {
      if (isMissingNativeFile(error)) return null;
      throw error;
    }
  }
  throw new Error("Native storage is unavailable outside the installed app.");
}

export async function writeNativeValue(key: string, value: unknown) {
  const desktop = desktopBridge();
  if (desktop) {
    await desktop.storage.write(key, value);
    return;
  }
  if (isMobileNativeApp()) {
    const json = JSON.stringify(value);
    if (typeof json !== "string") throw new TypeError("Native storage value is not JSON serializable.");
    assertNativeStorageSize(key, json);
    await Filesystem.writeFile({
      path: nativeStoragePath(key),
      data: json,
      directory: Directory.LibraryNoCloud,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    return;
  }
  throw new Error("Native storage is unavailable outside the installed app.");
}

export async function removeNativeValue(key: string) {
  const desktop = desktopBridge();
  if (desktop) {
    await desktop.storage.remove(key);
    return;
  }
  if (isMobileNativeApp()) {
    try {
      await Filesystem.deleteFile({ path: nativeStoragePath(key), directory: Directory.LibraryNoCloud });
    } catch (error) {
      if (!isMissingNativeFile(error)) throw error;
    }
    return;
  }
  throw new Error("Native storage is unavailable outside the installed app.");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string) {
  if (!value) return new Uint8Array();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Native sync returned malformed base64 data.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64(bytes) !== value) throw new Error("Native sync returned non-canonical base64 data.");
  return bytes;
}

async function requestBodyBase64(body: BodyInit | null | undefined) {
  if (body === null || body === undefined) return undefined;
  if (body instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  if (body instanceof Blob) return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
  throw new Error("The desktop sync bridge accepts binary encrypted bodies only.");
}

function nativeSyncRequest(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const sourceRequest = input instanceof Request ? input : null;
  const headers = new Headers(sourceRequest?.headers);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => { headerRecord[key] = value; });
  const method = init?.method ?? sourceRequest?.method ?? "GET";
  if (url !== NATIVE_SYNC_ENDPOINT) throw new TypeError("Only the production encrypted-sync endpoint is allowed.");
  if (method !== "GET" && method !== "PUT" && method !== "DELETE") throw new TypeError("Unsupported encrypted-sync method.");
  return { url, sourceRequest, headers: headerRecord, method };
}

function responseHeaders(record: Record<string, string>) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(record)) {
    if (typeof value === "string" && !/[\r\n]/u.test(name) && !/[\r\n]/u.test(value)) headers.set(name, value);
  }
  return headers;
}

function capacitorResponseBody(result: HttpResponse, headers: Headers) {
  if (result.status === 204 || result.status === 205 || result.data === null || result.data === undefined || result.data === "") return null;
  const contentType = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/octet-stream") {
    if (typeof result.data !== "string") throw new Error("Encrypted sync returned a non-binary native response.");
    return base64ToBytes(result.data);
  }
  return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
}

/** Sends exact binary envelopes through Capacitor's native HTTP API without UTF-8 conversion. */
export async function capacitorSyncFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  http: CapacitorHttpClient = CapacitorHttp,
): Promise<Response> {
  const request = nativeSyncRequest(input, init);
  const sourceBody = init?.body ?? (request.sourceRequest && request.method !== "GET" && request.method !== "HEAD" ? await request.sourceRequest.arrayBuffer() : undefined);
  const bodyBase64 = await requestBodyBase64(sourceBody);
  const result = await http.request({
    url: request.url,
    method: request.method,
    headers: request.headers,
    ...(bodyBase64 === undefined ? {} : { data: bodyBase64, dataType: "file" as const }),
    responseType: "arraybuffer",
    disableRedirects: true,
    connectTimeout: 20_000,
    readTimeout: 20_000,
  });
  const headers = responseHeaders(result.headers ?? {});
  return new Response(capacitorResponseBody(result, headers), {
    status: result.status,
    headers,
  });
}

/** Uses narrow native transports for Electron and Capacitor; Web keeps same-origin fetch. */
export const nativeSyncFetch: typeof fetch = async (input, init) => {
  const desktop = desktopBridge();
  if (!desktop) {
    if (isMobileNativeApp()) return capacitorSyncFetch(input, init);
    return globalThis.fetch(input, init);
  }

  const request = nativeSyncRequest(input, init);
  const sourceBody = init?.body ?? (request.sourceRequest && request.method !== "GET" && request.method !== "HEAD" ? await request.sourceRequest.arrayBuffer() : undefined);
  const result = await desktop.sync.fetch({
    url: request.url,
    method: request.method,
    headers: request.headers,
    bodyBase64: await requestBodyBase64(sourceBody),
  });
  const bytes = base64ToBytes(result.bodyBase64);
  const responseBody = result.status === 204 || result.status === 205 || bytes.length === 0 ? null : bytes;
  return new Response(responseBody, {
    status: result.status,
    statusText: result.statusText,
    headers: responseHeaders(result.headers),
  });
};

export function nativeSyncOptions() {
  if (!SYNC_RELAY_CONFIGURED) throw new Error("Encrypted sync relay is not configured for this release.");
  return isNativeApp() ? { endpoint: NATIVE_SYNC_ENDPOINT, fetchImpl: nativeSyncFetch } : {};
}

export async function exportNativeFile(filename: string, contents: string) {
  if (!isMobileNativeApp()) return false;
  if (!/^[a-z0-9._-]{1,160}$/i.test(filename)) throw new Error("Invalid native export filename.");
  const { uri } = await Filesystem.writeFile({
    path: `exports/${filename}`,
    data: contents,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  await Share.share({ title: filename, dialogTitle: filename, files: [uri] });
  return true;
}

export async function readNativeNotificationPermission(): Promise<NotificationPermission | null> {
  if (!isMobileNativeApp()) return null;
  const permission = await LocalNotifications.checkPermissions();
  return permission.display === "granted" ? "granted" : permission.display === "denied" ? "denied" : "default";
}

export async function requestNativeNotificationPermission(): Promise<NotificationPermission | null> {
  if (!isMobileNativeApp()) return null;
  const permission = await LocalNotifications.requestPermissions();
  return permission.display === "granted" ? "granted" : permission.display === "denied" ? "denied" : "default";
}

export async function scheduleNativeCompletionNotification(title: string, body: string, at: number) {
  if (!isMobileNativeApp()) return false;
  const permission = await readNativeNotificationPermission();
  if (permission !== "granted") return false;
  await LocalNotifications.cancel({ notifications: [{ id: NATIVE_TIMER_NOTIFICATION_ID }] }).catch(() => undefined);
  await LocalNotifications.schedule({
    notifications: [{
      id: NATIVE_TIMER_NOTIFICATION_ID,
      title,
      body,
      schedule: { at: new Date(Math.max(at, Date.now() + 100)) },
    }],
  });
  return true;
}

export async function cancelNativeCompletionNotification() {
  if (!isMobileNativeApp()) return false;
  await LocalNotifications.cancel({ notifications: [{ id: NATIVE_TIMER_NOTIFICATION_ID }] });
  return true;
}
