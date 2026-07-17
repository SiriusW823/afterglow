import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

// The release UI keeps sync disabled until an independently hosted relay has
// been published and tested. This reserved URL preserves a strict IPC allowlist.
const PRODUCTION_SYNC_URL = "https://sync.afterglow.invalid/api/private-sync";
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_SYNC_CONFIG_BYTES = 64 * 1024;
const MAX_SYNC_BODY_BYTES = 4 * 1024 * 1024;
const STORAGE_FILES = Object.freeze({
  snapshot: { filename: "afterglow-snapshot.json", maxBytes: MAX_SNAPSHOT_BYTES },
  "sync-config": { filename: "afterglow-sync-config.json", maxBytes: MAX_SYNC_CONFIG_BYTES },
});
const RESPONSE_HEADERS = new Set(["cache-control", "content-length", "content-type", "etag"]);
const writeQueues = new Map();

let mainWindow = null;
let rendererFileUrl = "";
let developmentOrigin = null;

app.enableSandbox();

function assertStorageKey(key) {
  if (typeof key !== "string" || !Object.hasOwn(STORAGE_FILES, key)) {
    throw new TypeError("Unsupported Afterglow storage key.");
  }
  return key;
}

function storagePath(key) {
  const safeKey = assertStorageKey(key);
  return path.join(app.getPath("userData"), STORAGE_FILES[safeKey].filename);
}

function assertJsonValue(key, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Afterglow ${key} must be a JSON object.`);
  }

  if (key === "sync-config") {
    const isRecord = value.__afterglowSyncRecord === 1
      && Number.isSafeInteger(value.revision)
      && value.revision >= 0
      && typeof value.writeId === "string"
      && value.writeId.length > 0
      && value.writeId.length <= 128
      && typeof value.deleted === "boolean";
    if (!isRecord) throw new TypeError("Invalid Afterglow sync storage record.");
    if (!value.deleted) {
      const config = value.value;
      const validConfig = config
        && typeof config === "object"
        && config.version === 1
        && /^[A-Za-z0-9_-]{22}$/u.test(config.roomId)
        && /^[A-Za-z0-9_-]{43}$/u.test(config.rootSecret)
        && Number.isSafeInteger(config.highestAcceptedGeneration)
        && config.highestAcceptedGeneration >= 0;
      if (!validConfig) throw new TypeError("Invalid Afterglow sync configuration.");
    }
  } else {
    const isRecord = value.__afterglowSnapshotRecord === 1
      && Number.isSafeInteger(value.revision)
      && value.revision >= 0
      && typeof value.writeId === "string"
      && value.writeId.length > 0
      && value.writeId.length <= 128
      && typeof value.deleted === "boolean";
    if (!isRecord || (!value.deleted && !("value" in value))) {
      throw new TypeError("Invalid Afterglow snapshot storage record.");
    }
  }

  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new TypeError(`Afterglow ${key} is not serializable.`);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > STORAGE_FILES[key].maxBytes) throw new RangeError(`Afterglow ${key} is too large.`);
  return json;
}

function runSerialized(key, operation) {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writeQueues.set(key, current.then(() => undefined, () => undefined));
  return current;
}

async function readJson(key) {
  return runSerialized(key, async () => {
    try {
      const file = storagePath(key);
      const raw = await readFile(file, "utf8");
      if (Buffer.byteLength(raw, "utf8") > STORAGE_FILES[key].maxBytes) {
        throw new RangeError(`Stored Afterglow ${key} is too large.`);
      }
      const parsed = JSON.parse(raw);
      assertJsonValue(key, parsed);
      return parsed;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") return null;
      throw error;
    }
  });
}

async function writeJson(key, value) {
  return runSerialized(key, async () => {
    const destination = storagePath(key);
    const directory = path.dirname(destination);
    const temporary = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    const json = assertJsonValue(key, value);
    await mkdir(directory, { recursive: true });

    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(json, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

async function removeJson(key) {
  return runSerialized(key, async () => {
    await rm(storagePath(key), { force: true });
  });
}

function configuredDevelopmentUrl() {
  const raw = process.env.AFTERGLOW_NATIVE_DEV_URL;
  if (!raw || app.isPackaged) return null;
  const url = new URL(raw);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    throw new Error("AFTERGLOW_NATIVE_DEV_URL must be an unauthenticated loopback HTTP URL.");
  }
  return url;
}

function isTrustedRendererUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (developmentOrigin) return url.origin === developmentOrigin;
    const expected = new URL(rendererFileUrl);
    url.hash = "";
    url.search = "";
    expected.hash = "";
    expected.search = "";
    return url.href === expected.href;
  } catch {
    return false;
  }
}

function assertTrustedSender(event) {
  const sender = event.sender;
  const frame = event.senderFrame;
  const rootFrame = sender.mainFrame;
  const isMainFrame = frame
    && rootFrame
    && frame.processId === rootFrame.processId
    && frame.routingId === rootFrame.routingId;
  if (!mainWindow || sender.id !== mainWindow.webContents.id || !isMainFrame || !isTrustedRendererUrl(frame.url)) {
    throw new Error("Untrusted Afterglow IPC sender.");
  }
}

function decodeBase64Body(value) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > Math.ceil(MAX_SYNC_BODY_BYTES / 3) * 4 + 4) {
    throw new TypeError("Invalid private-sync request body.");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError("Private-sync request body must be canonical base64.");
  }
  const body = Buffer.from(value, "base64");
  if (body.byteLength > MAX_SYNC_BODY_BYTES || body.toString("base64") !== value) {
    throw new RangeError("Private-sync request body is too large or malformed.");
  }
  return body;
}

function normalizeSyncRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Invalid private-sync request.");
  }
  if (request.url !== PRODUCTION_SYNC_URL) throw new TypeError("Only the production private-sync endpoint is allowed.");
  if (!new Set(["GET", "PUT", "DELETE"]).has(request.method)) throw new TypeError("Unsupported private-sync method.");
  if (!request.headers || typeof request.headers !== "object" || Array.isArray(request.headers)) {
    throw new TypeError("Invalid private-sync headers.");
  }

  const headers = new Headers();
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (!["authorization", "content-type", "if-match", "if-none-match"].includes(name) || typeof rawValue !== "string") {
      throw new TypeError("Unsupported private-sync header.");
    }
    if (/\r|\n/u.test(rawValue) || rawValue.length > 512) throw new TypeError("Invalid private-sync header value.");
    headers.set(name, rawValue);
  }

  if (!/^Afterglow [A-Za-z0-9_-]{43}$/u.test(headers.get("authorization") ?? "")) {
    throw new TypeError("Invalid private-sync authorization capability.");
  }

  const body = decodeBase64Body(request.bodyBase64);
  if (request.method === "PUT") {
    if (!body?.byteLength || headers.get("content-type") !== "application/octet-stream") {
      throw new TypeError("Private-sync PUT requires an octet-stream body.");
    }
    const hasMatch = headers.has("if-match");
    if (hasMatch && !headers.get("if-match")) throw new TypeError("Private-sync If-Match cannot be empty.");
    if (headers.has("if-none-match") && headers.get("if-none-match") !== "*") {
      throw new TypeError("Private-sync If-None-Match only accepts '*'.");
    }
    const hasCreate = headers.get("if-none-match") === "*";
    if (hasMatch === hasCreate) throw new TypeError("Private-sync PUT requires exactly one write precondition.");
  } else if (body !== undefined || headers.has("content-type") || headers.has("if-match") || headers.has("if-none-match")) {
    throw new TypeError("Private-sync GET and DELETE cannot include a body or write headers.");
  }

  return { method: request.method, headers, body };
}

async function fetchPrivateSync(request) {
  const normalized = normalizeSyncRequest(request);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(PRODUCTION_SYNC_URL, {
      method: normalized.method,
      headers: normalized.headers,
      body: normalized.body,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_SYNC_BODY_BYTES) {
      throw new RangeError("Private-sync response is too large.");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_SYNC_BODY_BYTES) throw new RangeError("Private-sync response is too large.");
    const headers = {};
    for (const [name, value] of response.headers) {
      if (RESPONSE_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    }
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      bodyBase64: body.toString("base64"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function registerIpc() {
  ipcMain.handle("afterglow:storage:read", (event, key) => {
    assertTrustedSender(event);
    return readJson(assertStorageKey(key));
  });
  ipcMain.handle("afterglow:storage:write", async (event, key, value) => {
    assertTrustedSender(event);
    await writeJson(assertStorageKey(key), value);
  });
  ipcMain.handle("afterglow:storage:remove", async (event, key) => {
    assertTrustedSender(event);
    await removeJson(assertStorageKey(key));
  });
  ipcMain.handle("afterglow:sync:fetch", (event, request) => {
    assertTrustedSender(event);
    return fetchPrivateSync(request);
  });
}

async function createWindow() {
  const developmentUrl = configuredDevelopmentUrl();
  developmentOrigin = developmentUrl?.origin ?? null;
  const rendererFile = path.join(app.getAppPath(), "native-dist", "index.html");
  rendererFileUrl = pathToFileURL(rendererFile).href;

  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 360,
    minHeight: 640,
    show: false,
    backgroundColor: "#f4efe8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), "desktop", "preload.mjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (developmentUrl) await window.loadURL(developmentUrl.href);
  else await window.loadFile(rendererFile);
}

const singleInstance = app.requestSingleInstanceLock();

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  await app.whenReady();
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
