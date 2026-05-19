#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { WebSocket, WebSocketServer } = require("ws");

const host = process.env.CODEXAPP_WEB_HOST || "127.0.0.1";
const port = Number(process.env.CODEXAPP_WEB_PORT || 12910);
const appServerPort = Number(process.env.CODEXAPP_APP_SERVER_PORT || 12911);
const webviewDir = path.resolve(process.env.CODEXAPP_WEBVIEW_DIR || path.join(process.cwd(), "webview"));
const codexCli = process.env.CODEXAPP_CODEX_CLI || "codex";
const home = process.env.HOME || os.homedir();
const codexHome = process.env.CODEX_HOME || process.env.CODEXAPP_CODEX_HOME || path.join(home, ".codex");
const stateDir = path.resolve(process.env.CODEXAPP_STATE_DIR || path.join(process.cwd(), "data", "state"));
const persistedAtomStatePath = path.join(stateDir, "persisted-atoms.json");
const hostStatePath = path.join(stateDir, "host-state.json");
const debugBridge = process.env.CODEXAPP_DEBUG_BRIDGE === "1";
const bridgePath = "/codexapp-bridge";
const bridgeScriptPath = "/codexapp-web-bridge.js";
const HOST_METHOD_NOT_HANDLED = Symbol("host-method-not-handled");
const codexPackageJsonPath = process.env.CODEXAPP_CODEX_PACKAGE_JSON || "/usr/local/lib/node_modules/@openai/codex/package.json";
const clientName = process.env.CODEXAPP_CLIENT_NAME || "codex-app-web-gateway";
const appDisplayName = process.env.CODEXAPP_DISPLAY_NAME || "Codex App Web Gateway";
const patchUpdateRequiredGate = process.env.CODEXAPP_PATCH_UPDATE_REQUIRED_GATE !== "0";
const accountProviderBaseUrl = normalizeOptionalUrl(process.env.CODEXAPP_ACCOUNT_PROVIDER_URL);
const accountProviderToken = process.env.CODEXAPP_ACCOUNT_PROVIDER_TOKEN || "";
const autoAccountSwitchEnabled = parseBoolean(process.env.CODEXAPP_AUTO_ACCOUNT_SWITCH, false) && !!accountProviderBaseUrl;
const accountProviderTimeoutMs = numberFromEnv("CODEXAPP_ACCOUNT_PROVIDER_TIMEOUT_MS", 15000, 1000, 120000);
const accountSwitchSettleMs = numberFromEnv("CODEXAPP_ACCOUNT_SWITCH_SETTLE_MS", 1500, 0, 60000);
const accountSwitchMinIntervalMs = numberFromEnv("CODEXAPP_ACCOUNT_SWITCH_MIN_INTERVAL_MS", 15000, 1000, 300000);
const accountSwitchForceReload = parseBoolean(process.env.CODEXAPP_ACCOUNT_SWITCH_FORCE_RELOAD, false);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".map", "application/json; charset=utf-8"],
]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function debugLog(...args) {
  if (debugBridge) log("[bridge]", ...args);
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function numberFromEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeOptionalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

let persistedAtomState = readJsonFile(persistedAtomStatePath, {});
let hostState = readJsonFile(hostStatePath, {});
const codexUiVersion = process.env.CODEXAPP_APP_VERSION
  || readJsonFile(codexPackageJsonPath, {})?.version
  || "0.131.0";

function savePersistedAtomState() {
  writeJsonFile(persistedAtomStatePath, persistedAtomState);
}

function saveHostState() {
  writeJsonFile(hostStatePath, hostState);
}

function defaultHostStateValue(key) {
  const defaults = {
    "git-always-force-push": false,
    "git-create-pull-request-as-draft": true,
    "git-pull-request-merge-method": "merge",
    "git-branch-prefix": "codex/",
    "git-commit-instructions": "",
    "git-pr-instructions": "",
    "sidebar-custom-sections": [],
    "sidebar-chat-thread-order": null,
    "sidebar-project-thread-orders": {},
    "sidebar-thread-metadata": {},
    "thread-project-assignments": {},
    "thread-writable-roots": {},
    "thread-workspace-root-hints": {},
    "projectless-thread-ids": [],
    "pinned-thread-ids": [],
    "pinned-project-ids": [],
    "project-order": [],
    "connection-group-order": [],
    "remote-projects": [],
    "remote-cwds-by-host-and-workspace": {},
    "active-remote-project-id": null,
    "selected-remote-host-id": "local",
    "added-remote-control-env-ids": [],
    "codex-mobile-has-connected-device": false,
    "remote-project-connection-backfill-completed": false,
    "remote-connection-auto-connect-by-host-id": {},
    "remote-connection-analytics-id-by-host-id": {},
    "ambient-suggestions-enabled": true,
    "ia-waiting-on-user-followup-seconds": 1800,
    "hotkey-window-projectless-default-enabled": false,
    "worktree-auto-cleanup-enabled": true,
    "worktree-keep-count": 15,
    "electron-saved-workspace-roots": [],
    "electron-workspace-root-labels": {},
    "active-workspace-roots": [],
    "open-in-target-preferences": {},
    "queued-follow-ups": [],
    "browser-annotation-screenshots-mode": "always",
    "reduced-motion-preference": "system",
    "notifications-turn-mode": "unfocused",
    "notifications-permissions-enabled": true,
    "notifications-questions-enabled": true,
  };
  return Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : undefined;
}

function readHostState(key) {
  return Object.prototype.hasOwnProperty.call(hostState, key) ? hostState[key] : defaultHostStateValue(key);
}

function writeHostState(key, value) {
  if (value === undefined) {
    delete hostState[key];
  } else {
    hostState[key] = value;
  }
  saveHostState();
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.length > 0))];
}

function readCodexCommandKeymapState() {
  const bindings = readHostState("codex-command-keymap-bindings");
  return {
    bindings: Array.isArray(bindings)
      ? bindings.filter((binding) => binding && typeof binding.command === "string")
      : [],
  };
}

function writeCodexCommandKeybinding(params = {}) {
  const command = typeof params.commandId === "string"
    ? params.commandId
    : (typeof params.command === "string" ? params.command : null);
  if (!command) return readCodexCommandKeymapState();

  const current = readCodexCommandKeymapState().bindings.filter((binding) => binding.command !== command);
  const key = params.key ?? params.keybinding ?? params.hotkey ?? params.binding?.key ?? null;
  if (typeof key === "string" && key.trim().length > 0) {
    current.push({ command, key: key.trim() });
  }
  writeHostState("codex-command-keymap-bindings", current);
  return { bindings: current };
}

function resolveReadableFilePath(input) {
  if (typeof input !== "string" || input.trim().length === 0) return null;
  const raw = input.trim();
  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [
        path.join(webviewDir, raw),
        path.join(codexHome, raw),
        path.join(home, raw),
      ];
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {}
  }
  return null;
}

function fileMetadataFor(input) {
  const filePath = resolveReadableFilePath(input);
  if (!filePath) {
    return { exists: false, isFile: false, isDirectory: false, sizeBytes: null };
  }
  const stat = fs.statSync(filePath);
  return {
    exists: true,
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    sizeBytes: stat.isFile() ? stat.size : null,
    mtimeMs: stat.mtimeMs,
  };
}

function fileBinaryFor(input) {
  const filePath = resolveReadableFilePath(input);
  if (!filePath) return { contentsBase64: null, mimeType: null, sizeBytes: null };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { contentsBase64: null, mimeType: null, sizeBytes: null };
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = (MIME_TYPES.get(ext) || "application/octet-stream").split(";")[0];
  return {
    contentsBase64: fs.readFileSync(filePath).toString("base64"),
    mimeType,
    sizeBytes: stat.size,
  };
}

function fileTextFor(input) {
  const filePath = resolveReadableFilePath(input);
  if (!filePath) return { contents: null };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { contents: null };
  return { contents: fs.readFileSync(filePath, "utf8") };
}

function gitOriginForDir(dir) {
  if (typeof dir !== "string" || dir.trim().length === 0) {
    return { dir, root: null, originUrl: null };
  }
  try {
    const root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    let originUrl = null;
    try {
      originUrl = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim() || null;
    } catch {}
    return { dir, root, originUrl };
  } catch {
    return { dir, root: null, originUrl: null };
  }
}

function slugifyDirectoryName(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "chat";
}

function projectlessWorkspaceRoot() {
  return path.join(home, "Documents", "Codex");
}

function createProjectlessWorkspace(params = {}) {
  const workspaceRoot = projectlessWorkspaceRoot();
  const datePrefix = new Date().toISOString().slice(0, 10);
  const requestedName = params.directoryName || params.prompt || "chat";
  const baseName = `${datePrefix}-${slugifyDirectoryName(requestedName)}`;
  fs.mkdirSync(workspaceRoot, { recursive: true });

  let cwd = path.join(workspaceRoot, baseName);
  let suffix = 2;
  while (fs.existsSync(cwd)) {
    cwd = path.join(workspaceRoot, `${baseName}-${suffix}`);
    suffix += 1;
  }
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, outputDirectory: cwd, workspaceRoot };
}

function generateThreadTitle(prompt) {
  const title = String(prompt || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return title || null;
}

function existingPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.filter((item) => {
    if (typeof item !== "string" || item.trim().length === 0) return false;
    try {
      return fs.existsSync(item);
    } catch {
      return false;
    }
  });
}

function send(res, status, headers, body = "") {
  res.writeHead(status, headers);
  res.end(body);
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const normalized = path.normalize(decoded)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const target = normalized === "" || normalized === "." ? "index.html" : normalized;
  const fullPath = path.resolve(root, target);
  const rootWithSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (fullPath !== root && !fullPath.startsWith(rootWithSeparator)) {
    return null;
  }
  return fullPath;
}

function injectBridge(indexHtml) {
  const script = `<script src="${bridgeScriptPath}"></script>`;
  if (indexHtml.includes(script)) {
    return indexHtml;
  }
  return indexHtml.replace(/<script type="module"/, `${script}\n    <script type="module"`);
}

function patchJavaScript(filePath, source) {
  if (patchUpdateRequiredGate && path.basename(filePath).startsWith("app-main-")) {
    return source.replace(/ec\(`2929582856`\)/g, "false");
  }
  return source;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name || "Error"} ${value.message || ""} ${value.stack || ""}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quotaTextSignal(value) {
  const text = safeString(value).toLowerCase();
  if (!text) return false;
  return [
    "usage_limit_reached",
    "workspace_owner_usage_limit_reached",
    "insufficient_quota",
    "quota_exceeded",
    "quota exceeded",
    "credits exhausted",
    "out of credits",
    "spending limit",
    "billing hard limit",
    "you've hit your usage limit",
    "you have hit your usage limit",
    "usage limit has been reached",
    "rate_limit_reached",
    "rate limit reached",
  ].some((needle) => text.includes(needle));
}

function numericPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function quotaBucketExhausted(bucket) {
  if (!bucket || typeof bucket !== "object") return false;
  const used = numericPercent(
    bucket.usedPercent
      ?? bucket.used_percent
      ?? bucket.usedPct
      ?? bucket.used_pct
      ?? bucket.percent
      ?? bucket.pct
  );
  if (used != null && used >= 99.5) return true;
  const remaining = numericPercent(
    bucket.remainingPercent
      ?? bucket.remaining_percent
      ?? bucket.remainingPct
      ?? bucket.remaining_pct
  );
  return remaining != null && remaining <= 0.5;
}

function rateLimitsExhausted(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.rateLimitReachedType || payload.rate_limit_reached_type) return true;
  if (payload.credits && payload.credits.hasCredits === false && payload.credits.unlimited !== true) return true;
  const candidates = [
    payload,
    payload.rateLimits,
    payload.rate_limits,
    payload.primary,
    payload.secondary,
    payload.fiveHour,
    payload.five_hour,
    payload.week,
    payload.weekly,
  ];
  if (payload.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === "object") {
    candidates.push(...Object.values(payload.rateLimitsByLimitId));
  }
  if (payload.rate_limits_by_limit_id && typeof payload.rate_limits_by_limit_id === "object") {
    candidates.push(...Object.values(payload.rate_limits_by_limit_id));
  }
  return candidates.some(quotaBucketExhausted);
}

function providerCurrentExhausted(payload) {
  if (!payload || typeof payload !== "object") return false;
  const account = payload.account || payload.activeSlot || payload.activeAccount || null;
  if (account && typeof account === "object") {
    const state = String(account.state || account.displayState || account.status || "").toLowerCase();
    if (["exhausted", "quota_exhausted", "no_quota", "rate_limited"].includes(state)) return true;
    const fiveHour = numericPercent(account.quota5hPct ?? account.quota_5h_pct ?? account.current_quota_5h_pct);
    const week = numericPercent(account.quotaWeekPct ?? account.quota_week_pct ?? account.current_quota_week_pct);
    if (fiveHour != null && fiveHour >= 99.5) return true;
    if (week != null && week >= 99.5) return true;
  }
  return rateLimitsExhausted(payload) || looksLikeQuotaExhausted(payload);
}

function looksLikeQuotaExhausted(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 5) return false;
  if (typeof value === "string") return quotaTextSignal(value);
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (value instanceof Error) {
    return quotaTextSignal(value) || looksLikeQuotaExhausted(value.cause, depth + 1, seen);
  }
  if (typeof value !== "object") return quotaTextSignal(value);
  if (seen.has(value)) return false;
  seen.add(value);
  if (rateLimitsExhausted(value)) return true;
  for (const key of ["code", "type", "name", "message", "error", "reason", "statusText", "rateLimitReachedType"]) {
    if (quotaTextSignal(value[key])) return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => looksLikeQuotaExhausted(item, depth + 1, seen));
  }
  return Object.values(value).some((item) => looksLikeQuotaExhausted(item, depth + 1, seen));
}

function accountProviderUrl(pathname) {
  if (!accountProviderBaseUrl) return null;
  const base = new URL(accountProviderBaseUrl);
  const cleanPath = String(pathname || "").replace(/^\/+/, "");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${cleanPath}`.replace(/\/{2,}/g, "/");
  return base.toString();
}

async function accountProviderJson(method, pathname, body) {
  const url = accountProviderUrl(pathname);
  if (!url) throw new Error("account provider is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), accountProviderTimeoutMs);
  const headers = {
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (accountProviderToken) {
    headers.authorization = `Bearer ${accountProviderToken}`;
    headers["x-codex-account-provider-token"] = accountProviderToken;
    headers["x-codex-switcher-verification-token"] = accountProviderToken;
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!response.ok) {
      const error = new Error(`account provider ${method} ${pathname} failed with ${response.status}`);
      error.status = response.status;
      error.body = json;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function compactProviderPayload(value) {
  if (value == null) return null;
  const text = safeString(value);
  if (text.length <= 4000) return value;
  return { summary: text.slice(0, 4000), truncated: true };
}

function browserBridgeScript() {
  return `(() => {
  const bridgeUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "${bridgePath}";
  const sharedObjects = {
    host_config: { id: "local", display_name: "Local", kind: "local" },
    remote_connections: [],
    remote_control_connections: []
  };
  const workerListeners = new Map();
  let socket = null;
  let connected = false;
  let reconnectTimer = null;
  const queue = [];

  function postToView(message) {
    window.postMessage(message, location.origin);
  }

  function flushQueue() {
    while (connected && queue.length > 0) {
      socket.send(JSON.stringify(queue.shift()));
    }
  }

  function sendToServer(message) {
    if (!message || typeof message.type !== "string") return Promise.resolve();
    if (message.type === "open-in-browser" && message.url) {
      window.open(message.url, "_blank", "noopener,noreferrer");
      return Promise.resolve();
    }
    if (message.type === "shared-object-set") {
      sharedObjects[message.key] = message.value;
      postToView({ type: "shared-object-updated", key: message.key, value: message.value });
    }
    if (connected) {
      socket.send(JSON.stringify(message));
    } else {
      queue.push(message);
    }
    return Promise.resolve();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    socket = new WebSocket(bridgeUrl);
    socket.addEventListener("open", () => {
      connected = true;
      flushQueue();
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "worker-message") {
        const listeners = workerListeners.get(message.workerId);
        if (listeners) {
          for (const listener of listeners) listener(message.message);
        }
        return;
      }
      if (message.type === "shared-object-updated") {
        sharedObjects[message.key] = message.value;
      }
      if (message.type === "codexapp-account-switch") {
        window.dispatchEvent(new CustomEvent("codexapp-account-switch", { detail: message }));
        if (message.reload) {
          setTimeout(() => location.reload(), Math.max(0, Number(message.reloadAfterMs || 250)));
        }
        return;
      }
      postToView(message);
    });
    socket.addEventListener("close", () => {
      connected = false;
      reconnectTimer = setTimeout(connect, 1000);
    });
    socket.addEventListener("error", () => {
      try { socket.close(); } catch {}
    });
  }

  window.electronBridge = {
    windowType: "main",
    getSharedObjectSnapshotValue(key) {
      return Object.prototype.hasOwnProperty.call(sharedObjects, key) ? sharedObjects[key] : null;
    },
    sendMessageFromView(message) {
      return sendToServer(message);
    },
    getPathForFile() {
      return null;
    },
    sendWorkerMessageFromView(workerId, message) {
      return sendToServer({ type: "worker-message", workerId, message });
    },
    subscribeToWorkerMessages(workerId, listener) {
      let listeners = workerListeners.get(workerId);
      if (!listeners) {
        listeners = new Set();
        workerListeners.set(workerId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) workerListeners.delete(workerId);
      };
    },
    showContextMenu() {
      return Promise.resolve();
    },
    showApplicationMenu() {
      return Promise.resolve();
    }
  };

  window.addEventListener("codex-message-from-view", (event) => {
    if (event.__codexForwardedViaBridge) return;
    sendToServer(event.detail);
  });

  connect();
})();`;
}

function sharedObjectValue(key) {
  switch (key) {
    case "host_config":
      return { id: "local", display_name: "Local", kind: "local" };
    case "remote_connections":
    case "remote_control_connections":
      return [];
    default:
      return null;
  }
}

class AppServerProcess {
  constructor() {
    this.child = null;
    this.startPromise = null;
  }

  async ensureStarted() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async stop(reason = "restart") {
    const child = this.child;
    this.startPromise = null;
    if (!child || child.killed) return;
    log("stopping codex app-server", { reason, pid: child.pid });
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killer = setTimeout(() => {
        if (!settled) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, 3000);
      killer.unref?.();
      child.once("exit", () => {
        clearTimeout(killer);
        finish();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(killer);
        finish();
      }
    });
  }

  async restart(reason = "restart") {
    await this.stop(reason);
    await delay(250);
    await this.ensureStarted();
  }

  async start() {
    if (this.child && !this.child.killed) return;
    const listenUrl = `ws://127.0.0.1:${appServerPort}`;
    log("starting codex app-server", listenUrl);
    this.child = spawn(codexCli, [
      "app-server",
      "--listen",
      listenUrl,
      "--analytics-default-enabled",
    ], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.on("exit", (code, signal) => {
      log("codex app-server exited", { code, signal });
      this.child = null;
      this.startPromise = null;
    });
    await this.waitForHealth();
  }

  async waitForHealth() {
    const url = `http://127.0.0.1:${appServerPort}/healthz`;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url);
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("codex app-server did not become healthy");
  }
}

const appServerProcess = new AppServerProcess();
const bridgeSessions = new Set();
let accountSwitchInFlight = null;
let lastAccountSwitchAttemptAt = 0;
let accountSwitchGeneration = 0;

function broadcastAccountSwitch(payload) {
  const message = {
    type: "codexapp-account-switch",
    timestamp: new Date().toISOString(),
    ...payload,
  };
  for (const session of bridgeSessions) {
    session.sendToBrowser(message);
  }
}

function resetBridgeAppSockets(reason) {
  for (const session of bridgeSessions) {
    session.resetAppSocket(reason);
  }
}

async function requestAccountSwitch(reason, details = {}) {
  if (!autoAccountSwitchEnabled) return { state: "disabled" };
  if (accountSwitchInFlight) return accountSwitchInFlight;
  const now = Date.now();
  if (now - lastAccountSwitchAttemptAt < accountSwitchMinIntervalMs) {
    return { state: "cooldown" };
  }
  lastAccountSwitchAttemptAt = now;

  accountSwitchInFlight = (async () => {
    const generation = ++accountSwitchGeneration;
    const payload = {
      reason,
      source: "codex-app-web-gateway",
      generation,
      timestamp: new Date().toISOString(),
      account: compactProviderPayload(details.account),
      rateLimits: compactProviderPayload(details.rateLimits),
      error: compactProviderPayload(details.error),
      method: details.method || null,
    };
    broadcastAccountSwitch({ phase: "started", reason, generation, reload: false });

    try {
      await accountProviderJson("POST", "/mark-quota-exhausted", payload).catch((error) => {
        log("account provider mark-quota-exhausted failed", error.message);
      });

      const lease = await accountProviderJson("POST", "/lease", payload);
      const accepted = lease && lease.ok !== false && (
        lease.accepted === true
        || lease.switched === true
        || lease.switchPending === true
        || lease.account
        || ["queued", "switching", "switched", "completed"].includes(String(lease.state || ""))
      );
      if (!accepted) {
        broadcastAccountSwitch({ phase: "declined", reason, generation, reload: false });
        return { state: "declined", provider: lease };
      }

      const settleMs = Number.isFinite(Number(lease.retryAfterMs ?? lease.settleMs))
        ? Math.max(0, Math.min(60000, Number(lease.retryAfterMs ?? lease.settleMs)))
        : accountSwitchSettleMs;
      if (settleMs > 0) await delay(settleMs);

      resetBridgeAppSockets("account switch");
      await appServerProcess.restart("account switch");
      resetBridgeAppSockets("account switch completed");

      const reload = accountSwitchForceReload || lease.requiresRefresh === true || lease.reload === true;
      broadcastAccountSwitch({
        phase: "completed",
        reason,
        generation,
        reload,
        reloadAfterMs: reload ? 250 : 0,
      });
      return { state: "switched", provider: lease, reload };
    } catch (error) {
      log("account switch failed", error.stack || error.message);
      broadcastAccountSwitch({
        phase: "failed",
        reason,
        generation,
        reload: accountSwitchForceReload,
        reloadAfterMs: accountSwitchForceReload ? 250 : 0,
      });
      return { state: "failed", error: error.message || String(error) };
    } finally {
      accountSwitchInFlight = null;
    }
  })();

  return accountSwitchInFlight;
}

class BridgeSession {
  constructor(browserSocket) {
    this.browserSocket = browserSocket;
    this.appSocket = null;
    this.pending = new Map();
    this.abortControllers = new Map();
    this.closed = false;
    bridgeSessions.add(this);
    this.browserSocket.on("message", (data) => this.handleBrowserMessage(data).catch((error) => {
      log("browser message error", error.stack || error.message);
    }));
    this.browserSocket.on("close", () => this.close());
  }

  close() {
    this.closed = true;
    bridgeSessions.delete(this);
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    for (const pending of this.pending.values()) {
      pending.reject(new Error("bridge session closed"));
    }
    this.pending.clear();
    if (this.appSocket) {
      try { this.appSocket.close(); } catch {}
    }
  }

  resetAppSocket(reason) {
    if (this.appSocket) {
      try { this.appSocket.close(); } catch {}
      this.appSocket = null;
    }
    const error = new Error(`app-server connection reset: ${reason}`);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  sendToBrowser(message) {
    if (this.closed || this.browserSocket.readyState !== WebSocket.OPEN) return;
    this.browserSocket.send(JSON.stringify(message));
  }

  async ensureAppSocket() {
    if (this.appSocket && this.appSocket.readyState === WebSocket.OPEN) return;
    await appServerProcess.ensureStarted();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${appServerPort}`);
      const timeout = setTimeout(() => reject(new Error("timeout connecting to app-server websocket")), 10000);
      ws.on("open", () => {
        clearTimeout(timeout);
        this.appSocket = ws;
        ws.on("message", (data) => this.handleAppMessage(data));
        ws.on("close", () => {
          if (this.appSocket === ws) this.appSocket = null;
        });
        ws.on("error", (error) => log("app-server websocket error", error.message));
        resolve();
      });
      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    await this.appRequest("initialize", {
      clientInfo: { name: clientName, title: appDisplayName, version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, { internal: true });
  }

  handleAppMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        debugLog("app-server internal error", message.id, message.error.message || message.error);
        if (looksLikeQuotaExhausted(message.error)) {
          void requestAccountSwitch("app-server-internal-quota-error", { error: message.error });
        }
        pending.reject(new Error(message.error.message || "app-server request failed"));
      } else {
        debugLog("app-server internal response", message.id);
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      debugLog("app-server response", message.id, "error" in message ? "error" : "result");
      if ("error" in message && looksLikeQuotaExhausted(message.error)) {
        void requestAccountSwitch("app-server-quota-error", {
          error: message.error,
          method: message.method || null,
        });
      }
      this.sendToBrowser({
        type: "mcp-response",
        hostId: "local",
        message: {
          id: message.id,
          ...("result" in message ? { result: message.result } : {}),
          ...("error" in message ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.id !== undefined && message.method) {
      debugLog("app-server request", message.method, message.id);
      this.sendToBrowser({
        type: "mcp-request",
        hostId: "local",
        request: {
          id: message.id,
          method: message.method,
          params: message.params,
        },
      });
      return;
    }

    if (message.method) {
      debugLog("app-server notification", message.method);
      if (rateLimitsExhausted(message.params) || looksLikeQuotaExhausted(message.params)) {
        void requestAccountSwitch("app-server-quota-notification", {
          rateLimits: message.params,
          method: message.method,
        });
      }
      this.sendToBrowser({
        type: "mcp-notification",
        hostId: "local",
        method: message.method,
        params: message.params,
      });
    }
  }

  async appRequest(method, params, options = {}) {
    await this.ensureAppSocket();
    const id = options.id || `${options.internal ? "bridge" : "fetch"}-${crypto.randomUUID()}`;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (options.timeoutMs) {
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error("app-server request timed out"));
        }, options.timeoutMs).unref?.();
      }
    });
    this.appSocket.send(JSON.stringify(payload));
    return promise;
  }

  async appSend(message) {
    await this.ensureAppSocket();
    this.appSocket.send(JSON.stringify(message));
  }

  async readCurrentAccountForProvider() {
    try {
      return await this.appRequest("account/read", { refreshToken: false }, { timeoutMs: 30000, internal: true });
    } catch {
      return null;
    }
  }

  async preflightAccountSwitchForRequest(request) {
    if (!autoAccountSwitchEnabled || !request || request.method !== "turn/start") return;
    try {
      const providerCurrent = await accountProviderJson("GET", "/current").catch(() => null);
      if (providerCurrentExhausted(providerCurrent)) {
        await requestAccountSwitch("turn-start-provider-preflight", {
          method: request.method,
          rateLimits: providerCurrent,
          account: providerCurrent?.account || await this.readCurrentAccountForProvider(),
        });
        return;
      }
      const rateLimits = await this.appRequest("account/rateLimits/read", {}, { timeoutMs: 30000, internal: true });
      if (!rateLimitsExhausted(rateLimits)) return;
      await requestAccountSwitch("turn-start-preflight", {
        method: request.method,
        rateLimits,
        account: await this.readCurrentAccountForProvider(),
      });
    } catch (error) {
      if (looksLikeQuotaExhausted(error)) {
        await requestAccountSwitch("turn-start-preflight-error", {
          method: request.method,
          error,
          account: await this.readCurrentAccountForProvider(),
        });
      }
    }
  }

  async handleBrowserMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (message.type) {
      case "mcp-request":
      case "thread-prewarm-start":
        debugLog("browser request", message.request?.method, message.request?.id);
        await this.forwardClientRequest(message);
        break;
      case "mcp-notification":
        debugLog("browser notification", message.request?.method);
        await this.forwardClientNotification(message);
        break;
      case "mcp-response":
        debugLog("browser response", message.response?.id);
        await this.forwardClientResponse(message);
        break;
      case "fetch":
        debugLog("browser fetch", message.url, message.requestId);
        await this.handleFetch(message);
        break;
      case "fetch-stream":
        await this.handleFetchStream(message);
        break;
      case "cancel-fetch":
      case "cancel-fetch-stream":
        this.cancelFetch(message.requestId);
        break;
      case "shared-object-subscribe":
        this.sendToBrowser({ type: "shared-object-updated", key: message.key, value: sharedObjectValue(message.key) });
        break;
      case "shared-object-set":
        break;
      case "shared-object-unsubscribe":
        break;
      case "persisted-atom-sync-request":
        debugLog("persisted atom sync request");
        this.sendToBrowser({ type: "persisted-atom-sync", state: persistedAtomState });
        break;
      case "persisted-atom-update":
        debugLog("persisted atom update", message.key);
        this.updatePersistedAtom(message);
        break;
      case "persisted-atom-reset":
        persistedAtomState = {};
        savePersistedAtomState();
        this.sendToBrowser({ type: "persisted-atom-sync", state: persistedAtomState });
        break;
      case "log-message":
      case "desktop-notification-hide":
      case "desktop-notification-show":
      case "electron-app-state-snapshot-trigger":
      case "electron-app-state-snapshot-response":
      case "electron-window-focus-request":
      case "hotkey-window-enabled-changed":
      case "global-dictation-enabled-changed":
      case "heartbeat-automations-enabled-changed":
      case "codex-runtimes-config-changed":
      case "electron-avatar-overlay-restore-ready":
      case "local-thread-activity-changed":
      case "set-telemetry-user":
      case "electron-set-badge-count":
      case "tray-menu-threads-changed":
      case "keyboard-layout-map-changed":
      case "mac-menu-bar-enabled-changed":
      case "electron-desktop-features-changed":
      case "electron-set-window-mode":
      case "power-save-blocker-set":
      case "avatar-overlay-open-state-request":
      case "browser-sidebar-owner-sync":
      case "browser-use-non-local-sites-allowed-changed":
      case "browser-use-turn-route-capture":
      case "browser-use-turn-route-release":
      case "computer-use-turn-route-capture":
      case "computer-use-turn-route-release":
      case "app-shell-shortcut-state-changed":
      case "thread-stream-state-changed":
      case "heartbeat-automation-thread-state-changed":
      case "query-cache-invalidate":
      case "ready":
      case "view-focused":
        break;
      case "worker-message":
        this.sendToBrowser(message);
        break;
      default:
        log("unhandled browser bridge message", message.type);
        break;
    }
  }

  updatePersistedAtom(message) {
    if (!message || typeof message.key !== "string") return;
    if (message.deleted || message.value === undefined) {
      delete persistedAtomState[message.key];
    } else {
      persistedAtomState[message.key] = message.value;
    }
    savePersistedAtomState();
    this.sendToBrowser({
      type: "persisted-atom-updated",
      key: message.key,
      value: message.deleted ? null : message.value,
      deleted: !!message.deleted,
    });
  }

  async forwardClientRequest(message) {
    const request = message.request;
    if (!request || request.id === undefined || !request.method) return;
    await this.preflightAccountSwitchForRequest(request);
    debugLog("to app-server", request.method, request.id);
    await this.appSend({
      jsonrpc: "2.0",
      id: request.id,
      method: request.method,
      params: request.params,
    });
  }

  async forwardClientNotification(message) {
    const request = message.request;
    if (!request || !request.method) return;
    await this.appSend({
      jsonrpc: "2.0",
      method: request.method,
      params: request.params,
    });
  }

  async forwardClientResponse(message) {
    const response = message.response;
    if (!response || response.id === undefined) return;
    await this.appSend({
      jsonrpc: "2.0",
      id: response.id,
      ...("error" in response ? { error: response.error } : { result: response.result }),
    });
  }

  cancelFetch(requestId) {
    const controller = this.abortControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(requestId);
    }
  }

  async handleCodexHostMethod(method, params = {}) {
    switch (method) {
      case "account-info": {
        const account = await this.appRequest("account/read", { refreshToken: false }, { timeoutMs: 30000 });
        const chatgptAccount = account?.account?.type === "chatgpt" ? account.account : null;
        return {
          accountId: null,
          userId: null,
          plan: chatgptAccount?.planType ?? null,
          email: chatgptAccount?.email ?? null,
        };
      }
      case "get-auth-status": {
        return this.appRequest("getAuthStatus", {}, { timeoutMs: 30000 });
      }
      case "get-global-state":
        return { value: readHostState(params.key) };
      case "set-global-state":
        writeHostState(params.key, params.value);
        this.sendToBrowser({ type: "global-state-updated", keys: [params.key] });
        return { success: true };
      case "get-configuration":
        return { value: readHostState(params.key) };
      case "set-configuration":
        writeHostState(params.key, params.value);
        return { success: true };
      case "active-workspace-roots":
        return { roots: uniqueStrings(readHostState("active-workspace-roots")) };
      case "workspace-root-options":
        return {
          roots: uniqueStrings(readHostState("electron-saved-workspace-roots")),
          labels: readHostState("electron-workspace-root-labels") || {},
        };
      case "add-workspace-root-option": {
        const root = typeof params.root === "string" ? params.root : null;
        if (root) {
          writeHostState("electron-saved-workspace-roots", uniqueStrings([root, ...uniqueStrings(readHostState("electron-saved-workspace-roots"))]));
          if (params.label) {
            writeHostState("electron-workspace-root-labels", {
              ...(readHostState("electron-workspace-root-labels") || {}),
              [root]: params.label,
            });
          }
          if (params.setActive) {
            writeHostState("active-workspace-roots", [root]);
            this.sendToBrowser({ type: "active-workspace-roots-updated" });
          }
          this.sendToBrowser({ type: "workspace-root-options-updated" });
        }
        return { success: true };
      }
      case "remove-workspace-root-option": {
        const root = typeof params.root === "string" ? params.root : null;
        if (root) {
          writeHostState("electron-saved-workspace-roots", uniqueStrings(readHostState("electron-saved-workspace-roots")).filter((item) => item !== root));
          const labels = { ...(readHostState("electron-workspace-root-labels") || {}) };
          delete labels[root];
          writeHostState("electron-workspace-root-labels", labels);
          writeHostState("active-workspace-roots", uniqueStrings(readHostState("active-workspace-roots")).filter((item) => item !== root));
          this.sendToBrowser({ type: "workspace-root-options-updated" });
          this.sendToBrowser({ type: "active-workspace-roots-updated" });
        }
        return { success: true };
      }
      case "codex-home":
        return {
          codexHome,
          worktreesSegment: path.join(codexHome, "worktrees"),
        };
      case "home-directory":
        return { homeDirectory: home };
      case "projectless-thread-cwd":
        return createProjectlessWorkspace(params);
      case "projectless-workspace-root":
        return { workspaceRoot: projectlessWorkspaceRoot() };
      case "ide-context":
        return { ideContext: null };
      case "read-file-metadata":
        return fileMetadataFor(params.path);
      case "read-file-binary":
        return fileBinaryFor(params.path);
      case "read-file":
        return fileTextFor(params.path);
      case "git-origins": {
        const dirs = Array.isArray(params.dirs) ? params.dirs : uniqueStrings(readHostState("active-workspace-roots"));
        return { origins: dirs.map(gitOriginForDir) };
      }
      case "generate-thread-title":
        return { title: generateThreadTitle(params.prompt) };
      case "paths-exist":
        return { existingPaths: existingPaths(params.paths) };
      case "mcp-codex-config":
        return { config: {} };
      case "worktree-shell-environment-config":
        return { shellEnvironment: null };
      case "developer-instructions":
        return { instructions: typeof params.baseInstructions === "string" ? params.baseInstructions : "" };
      case "fast-mode-rollout-metrics":
        return { metrics: null };
      case "list-automations":
        return { items: [] };
      case "list-pending-automation-run-threads":
        return { threadIds: [] };
      case "inbox-items":
        return { items: [] };
      case "codex-command-keymap-state":
        return readCodexCommandKeymapState();
      case "set-codex-command-keybinding":
        return writeCodexCommandKeybinding(params);
      case "hotkey-window-hotkey-state":
        return { supported: false };
      case "hotkey-window-set-hotkey":
        return { success: false, error: "Global hotkeys are not available in the web deployment.", state: { supported: false } };
      case "global-dictation-hotkey-state":
        return { supported: false };
      case "ambient-suggestions":
        return { suggestions: [], items: [] };
      case "ambient-suggestions-generation-statuses":
        return { statuses: [] };
      case "ambient-suggestions-refresh":
        return { success: true, suggestions: [] };
      case "recommended-skills":
        return { skills: [], error: null };
      case "external-agent-imported-connectors":
        return { connectors: [] };
      case "list-pinned-threads":
        return { threadIds: uniqueStrings(readHostState("pinned-thread-ids")) };
      case "set-thread-pinned": {
        const threadId = typeof params.threadId === "string" ? params.threadId : null;
        if (threadId) {
          const current = uniqueStrings(readHostState("pinned-thread-ids")).filter((item) => item !== threadId);
          writeHostState("pinned-thread-ids", params.pinned ? [threadId, ...current] : current);
          this.sendToBrowser({ type: "pinned-threads-updated" });
        }
        return { success: true };
      }
      case "set-pinned-threads-order":
        writeHostState("pinned-thread-ids", uniqueStrings(params.threadIds));
        this.sendToBrowser({ type: "pinned-threads-updated" });
        return { success: true };
      case "set-remote-control-connections-enabled":
      case "refresh-remote-control-connections":
      case "authorize-remote-control-connections":
        return { success: true };
      case "has-custom-cli-executable":
        return { hasCustomCliExecutable: false };
      case "is-copilot-api-available":
        return { available: false };
      case "get-copilot-api-proxy-info":
        return null;
      case "extension-info":
        return {
          version: codexUiVersion,
          buildNumber: null,
          buildFlavor: "prod",
          osName: "Linux",
          systemVersion: os.release(),
          appName: "Codex",
          appIconMedium: null,
        };
      case "third-party-notices":
        return { text: null };
      case "locale-info":
        return { ideLocale: "en-US", systemLocale: Intl.DateTimeFormat().resolvedOptions().locale || "en-US" };
      case "os-info":
        return {
          platform: process.platform,
          osVersion: os.version?.() || os.release(),
          osRelease: os.release(),
          hasWsl: false,
          isVsCodeRunningInsideWsl: false,
        };
      case "wsl-bash-availability":
        return { available: false };
      case "chronicle-permissions":
        return {
          accessibility: "not-determined",
          screenRecording: "not-determined",
          chronicleSidecarPresent: false,
          chronicleSidecarProcessState: "disabled",
        };
      case "computer-use-app-approvals-visibility":
        return { hasApprovalStore: false };
      case "computer-use-app-approvals-read":
        return { approvals: [] };
      case "computer-use-sound-mode-read":
        return { value: "off" };
      case "computer-use-background-auth-read":
        return { enabled: false };
      case "browser-browsing-data-clear":
        return { success: true };
      case "email-domain-mail-provider":
        return { provider: null };
      default:
        return HOST_METHOD_NOT_HANDLED;
    }
  }

  async handleLocalHttpFetch(message) {
    const url = String(message.url || "");
    if (url.startsWith("/wham/accounts/check")) {
      let email = null;
      let plan = null;
      try {
        const account = await this.appRequest("account/read", { refreshToken: false }, { timeoutMs: 30000 });
        const chatgptAccount = account?.account?.type === "chatgpt" ? account.account : null;
        email = chatgptAccount?.email ?? null;
        plan = chatgptAccount?.planType ?? null;
      } catch {}
      const accountId = "local";
      return {
        account_ordering: [accountId],
        accounts: [{
          id: accountId,
          email,
          plan_type: plan,
          profile_picture_url: null,
        }],
      };
    }
    if (url.startsWith("/wham/tasks/list")) {
      return { items: [], cursor: null };
    }
    if (url.startsWith("/wham/tasks/")) {
      return { items: [], turns: [], task: null };
    }
    if (url.startsWith("/wham/usage")) {
      return null;
    }
    if (url.startsWith("/beacons/")) {
      return { ok: true };
    }
    return HOST_METHOD_NOT_HANDLED;
  }

  async handleFetch(message) {
    const controller = new AbortController();
    this.abortControllers.set(message.requestId, controller);
    try {
      if (String(message.url || "").startsWith("vscode://codex/")) {
        const method = message.url.slice("vscode://codex/".length);
        const params = message.body ? JSON.parse(message.body) : undefined;
        const hostResult = await this.handleCodexHostMethod(method, params);
        if (hostResult !== HOST_METHOD_NOT_HANDLED) {
          this.sendFetchSuccess(message.requestId, 200, { "content-type": "application/json" }, hostResult ?? null);
          debugLog("host fetch success", method, message.requestId);
          return;
        }
        debugLog("fetch to app-server", method, message.requestId);
        const result = await this.appRequest(method, params, {
          id: `fetch-${message.requestId}`,
          timeoutMs: 120000,
        });
        this.sendFetchSuccess(message.requestId, 200, { "content-type": "application/json" }, result ?? null);
        debugLog("fetch success", method, message.requestId);
        return;
      }

      const localHttpResult = await this.handleLocalHttpFetch(message);
      if (localHttpResult !== HOST_METHOD_NOT_HANDLED) {
        this.sendFetchSuccess(message.requestId, 200, { "content-type": "application/json" }, localHttpResult ?? null);
        debugLog("local http fetch success", message.url, message.requestId);
        return;
      }

      const response = await fetch(message.url, {
        method: message.method || "GET",
        headers: message.headers || {},
        body: message.body || undefined,
        signal: controller.signal,
      });
      await this.sendHttpFetchResponse(message.requestId, response);
    } catch (error) {
      if (looksLikeQuotaExhausted(error)) {
        void requestAccountSwitch("fetch-quota-error", { error, method: message.url || null });
      }
      this.sendFetchError(
        message.requestId,
        error.name === "AbortError" ? 499 : 500,
        error.message || "Fetch failed"
      );
    } finally {
      this.abortControllers.delete(message.requestId);
    }
  }

  async sendHttpFetchResponse(requestId, response) {
    const headers = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    if (!response.ok) {
      const errorText = await response.text() || response.statusText;
      if (looksLikeQuotaExhausted(errorText)) {
        void requestAccountSwitch("http-fetch-quota-error", { error: errorText });
      }
      this.sendFetchError(requestId, response.status, errorText);
      return;
    }
    const contentType = response.headers.get("content-type") || "";
    if (response.status === 204) {
      this.sendFetchSuccess(requestId, response.status, headers, null);
    } else if (contentType.includes("application/json")) {
      this.sendFetchSuccess(requestId, response.status, headers, await response.json());
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      this.sendFetchSuccess(requestId, response.status, headers, {
        base64: buffer.toString("base64"),
        contentType,
      });
    }
  }

  sendFetchSuccess(requestId, status, headers, body) {
    this.sendToBrowser({
      type: "fetch-response",
      responseType: "success",
      requestId,
      status,
      headers,
      bodyJsonString: JSON.stringify(body),
    });
  }

  sendFetchError(requestId, status, error) {
    this.sendToBrowser({
      type: "fetch-response",
      responseType: "error",
      requestId,
      status,
      error,
    });
  }

  async handleFetchStream(message) {
    const controller = new AbortController();
    this.abortControllers.set(message.requestId, controller);
    try {
      const response = await fetch(message.url, {
        method: message.method || "GET",
        headers: message.headers || {},
        body: message.body || undefined,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const errorText = await response.text() || response.statusText;
        if (looksLikeQuotaExhausted(errorText)) {
          void requestAccountSwitch("fetch-stream-quota-error", { error: errorText });
        }
        this.sendToBrowser({
          type: "fetch-stream-error",
          requestId: message.requestId,
          status: response.status,
          error: errorText,
        });
        return;
      }
      await this.pipeServerSentEvents(message.requestId, response.body, controller.signal);
      this.sendToBrowser({ type: "fetch-stream-complete", requestId: message.requestId });
    } catch (error) {
      if (looksLikeQuotaExhausted(error)) {
        void requestAccountSwitch("fetch-stream-quota-exception", { error, method: message.url || null });
      }
      this.sendToBrowser({
        type: "fetch-stream-error",
        requestId: message.requestId,
        status: error.name === "AbortError" ? 499 : 500,
        error: error.message || "Fetch stream failed",
      });
    } finally {
      this.abortControllers.delete(message.requestId);
    }
  }

  async pipeServerSentEvents(requestId, body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(raw.includes("\r\n\r\n") ? boundary + 4 : boundary + 2);
          const event = this.parseSseEvent(raw);
          if (event && event.event !== "heartbeat") {
            this.sendToBrowser({ type: "fetch-stream-event", requestId, ...event });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  parseSseEvent(raw) {
    const data = [];
    let event = undefined;
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return null;
    try {
      return { event, data: JSON.parse(data.join("\n")) };
    } catch {
      return null;
    }
  }
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      send(res, 200, { "Content-Type": "application/json" }, JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/favicon.ico") {
      send(res, 200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=3600" });
      return;
    }
    if (url.pathname === bridgeScriptPath) {
      send(res, 200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      }, browserBridgeScript());
      return;
    }
    const filePath = safeJoin(webviewDir, url.pathname);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      "Content-Type": MIME_TYPES.get(ext) || "application/octet-stream",
      "Cache-Control": ext === ".html" || ext === ".js" ? "no-store" : "public, max-age=3600",
    };
    if (path.basename(filePath) === "index.html") {
      send(res, 200, headers, injectBridge(fs.readFileSync(filePath, "utf8")));
      return;
    }
    if (ext === ".js" && path.basename(filePath).startsWith("app-main-")) {
      send(res, 200, {
        ...headers,
        "Cache-Control": "no-store",
      }, patchJavaScript(filePath, fs.readFileSync(filePath, "utf8")));
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    send(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, error.stack || error.message);
  }
});

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (socket) => {
  debugLog("browser websocket connected");
  new BridgeSession(socket);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== bridgePath) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(port, host, () => {
  log(`${appDisplayName} web bridge listening on http://${host}:${port}`);
});
