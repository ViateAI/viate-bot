import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from "electron";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { bindDevice, egressWebSocketUrl, startEgressClient, type EgressClientHandle } from "@viate-bot/egress-client";
import { createLogger } from "./log.js";
import { acceptedBaseUrl, externalAllowed, parseBaseInput } from "./policy.js";
import { encryptedTokenStore, type StringCipher } from "./secrets.js";
import { readDesktopSettings, writeDesktopSettings, type DesktopSettings } from "./settings.js";

declare const __dirname: string;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const BIND_ERROR: Record<string, true> = {
  "系统加密不可用，已拒绝保存设备令牌": true,
  "系统加密不可用，无法读取设备令牌": true,
  "等待回调超时": true,
  "state 不匹配": true,
  "换取设备令牌失败": true,
  "回调端口没有监听": true,
  "需要令牌存储": true,
  "绑定地址被拒绝": true,
};

export interface DesktopHooks {
  allowPrivate?: () => ((ip: string) => boolean) | undefined;
}

export function startDesktop(hooks: DesktopHooks): void {
  app.setName("viate-bot");
  if (__VB_DESKTOP_DEV__) {
    const override = process.env.VB_DESKTOP_USER_DATA;
    if (override && path.isAbsolute(override)) app.setPath("userData", override);
  }
  protocol.registerSchemesAsPrivileged([
    { scheme: "vbapp", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const root = __dirname;
  const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
  const tokenFile = () => path.join(app.getPath("userData"), "device-token.bin");
  const log = createLogger(path.join(app.getPath("userData"), "logs", "desktop.log"));
  let settings = readDesktopSettings(settingsFile());
  const normalized = settings.baseUrl ? acceptedBaseUrl(settings.baseUrl, __VB_DESKTOP_DEV__) : null;
  if (settings.baseUrl && !normalized) {
    settings.baseUrl = "";
    writeDesktopSettings(settingsFile(), settings);
    log.write("base-cleared", { category: "config" });
  } else if (normalized) settings.baseUrl = normalized;

  let client: EgressClientHandle | null = null;
  let unsubscribe: (() => void) | undefined;
  let bound = false;
  let binding = false;
  let confirming = false;
  let quitting = false;
  let setupWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let persistTimer: NodeJS.Timeout | undefined;

  function syncDock(): void {
    if (process.platform !== "darwin" || !app.dock) return;
    const open = setupWindow !== null && !setupWindow.isDestroyed();
    if (open) void app.dock.show();
    else app.dock.hide();
  }

  app.on("second-instance", () => {
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.show();
      setupWindow.focus();
    }
  });
  app.on("window-all-closed", () => undefined);
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("will-redirect", (event) => event.preventDefault());
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    if (!settings.openAtLogin) app.setLoginItemSettings({ openAtLogin: false });
    flushSettings();
    void stopClient().finally(() => app.quit());
  });

  void app.whenReady().then(async () => {
    protocol.handle("vbapp", (request) => serveRenderer(root, request));
    hardenSession();
    tray = new Tray(trayIcon());
    tray.setToolTip("viate-bot");
    app.setLoginItemSettings({ openAtLogin: settings.openAtLogin });
    installIpc();
    let token: string | null = null;
    try {
      token = await encryptedTokenStore(tokenFile(), cipher()).read() ?? null;
    } catch (error) {
      log.write("token-read", { category: error instanceof Error && error.message.includes("加密") ? "encryption" : "token" });
      await dialog.showMessageBox({ type: "error", message: "系统加密不可用，无法读取设备令牌", detail: "不会改用明文。" });
    }
    try {
      if (settings.baseUrl && token) await startClient(token);
      else openSetup();
    } catch {
      log.write("start-failed", { category: "client" });
      openSetup();
    }
    renderMenu();
    syncDock();
  });

  function cipher(): StringCipher {
    return {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (blob) => safeStorage.decryptString(blob),
    };
  }

  function flushSettings(): void {
    clearTimeout(persistTimer);
    persistTimer = undefined;
    writeDesktopSettings(settingsFile(), settings);
  }

  function schedulePersist(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      writeDesktopSettings(settingsFile(), settings);
    }, 1000);
    persistTimer.unref();
  }

  async function stopClient(): Promise<void> {
    unsubscribe?.();
    unsubscribe = undefined;
    const current = client;
    client = null;
    if (current) await current.close();
  }

  async function startClient(token: string): Promise<void> {
    await stopClient();
    const allowPrivate = hooks.allowPrivate?.();
    client = startEgressClient({
      url: egressWebSocketUrl(settings.baseUrl),
      token,
      allowFakeIp: settings.allowFakeIp,
      initialStats: { day: settings.statsDay, bytes: settings.statsBytes },
      ...(allowPrivate ? { allowPrivate } : {}),
    });
    bound = true;
    unsubscribe = client.subscribe((event) => {
      if (event.type === "stats") {
        settings.statsDay = event.day;
        settings.statsBytes = event.bytesToday;
        schedulePersist();
        renderMenu();
        return;
      }
      if (event.type === "dial") log.write("dial", { category: event.category });
      if (event.type === "status") log.write("status", { phase: event.phase });
      renderMenu();
    });
  }

  function displayPhase(): "online" | "offline" | "paused" | "unbound" {
    if (!bound) return "unbound";
    return client?.snapshot().phase ?? "offline";
  }

  function renderMenu(): void {
    if (!tray) return;
    const phase = displayPhase();
    const bytes = client?.snapshot().bytesToday ?? settings.statsBytes;
    const label = phase === "online" ? "在线" : phase === "paused" ? "已暂停" : phase === "unbound" ? "未绑定" : "离线";
    tray.setToolTip(`viate-bot：${label}`);
    const menu = Menu.buildFromTemplate([
      { label: `状态：${label}`, enabled: false },
      { label: `今日流量：${formatBytes(bytes)}`, enabled: false },
      { type: "separator" },
      phase === "paused"
        ? { label: "恢复", click: () => resumeClient() }
        : { label: "暂停", enabled: phase === "online" || phase === "offline", click: () => pauseClient() },
      { type: "checkbox", label: "允许 fake-ip", checked: settings.allowFakeIp, click: (item) => void toggleFakeIp(item.checked) },
      { label: "打开 viate-bot", enabled: settings.baseUrl.length > 0, click: () => openApp() },
      { type: "checkbox", label: "开机自启动", checked: settings.openAtLogin, click: (item) => setOpenAtLogin(item.checked) },
      { type: "separator" },
      { label: "退出登录", enabled: bound, click: () => void logout() },
      { label: "退出程序", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  }

  function pauseClient(): void {
    client?.pause();
    log.write("pause", {});
    renderMenu();
  }

  function resumeClient(): void {
    client?.resume();
    log.write("resume", {});
    renderMenu();
  }

  async function toggleFakeIp(next: boolean): Promise<void> {
    if (confirming) {
      renderMenu();
      return;
    }
    if (next && !settings.allowFakeIp) {
      confirming = true;
      try {
        const result = await dialog.showMessageBox({
          type: "warning",
          buttons: ["取消", "仍然允许"],
          defaultId: 0,
          cancelId: 0,
          title: "允许 fake-ip",
          message: "fake-ip 会隐藏真实目标",
          detail: "打开后只额外放行 198.18.0.0/15，其它私网地址仍然拒绝。如果代理软件把这些地址直连进内网，机器就能访问你的内网。",
        });
        if (result.response !== 1) {
          renderMenu();
          return;
        }
      } finally {
        confirming = false;
      }
    }
    settings.allowFakeIp = next;
    flushSettings();
    client?.setAllowFakeIp(next);
    log.write("fake-ip", { allow: next });
    renderMenu();
  }

  function setOpenAtLogin(open: boolean): void {
    settings.openAtLogin = open;
    flushSettings();
    app.setLoginItemSettings({ openAtLogin: open });
    log.write("login-item", { open });
    renderMenu();
  }

  function openApp(): void {
    if (!settings.baseUrl) return;
    const target = new URL("/", settings.baseUrl).toString();
    if (!externalAllowed(target, settings.baseUrl)) {
      log.write("open-external-blocked", { category: "origin" });
      return;
    }
    void shell.openExternal(target);
  }

  async function logout(): Promise<void> {
    await stopClient();
    bound = false;
    await encryptedTokenStore(tokenFile(), cipher()).clear();
    log.write("logout", {});
    renderMenu();
    openSetup();
  }

  function openSetup(): void {
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.show();
      setupWindow.focus();
      syncDock();
      return;
    }
    const win = new BrowserWindow({
      width: 420,
      height: 280,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      title: "viate-bot",
      webPreferences: {
        preload: path.join(root, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
      },
    });
    setupWindow = win;
    win.on("closed", () => {
      if (setupWindow === win) setupWindow = null;
      syncDock();
    });
    void win.loadURL("vbapp://local/index.html");
    syncDock();
  }

  function installIpc(): void {
    ipcMain.handle("desktop:get-state", (event) => {
      if (!fromApp(event)) return { ok: false, error: "拒绝" };
      const phase = displayPhase();
      return {
        dev: __VB_DESKTOP_DEV__,
        baseUrl: settings.baseUrl,
        phase,
        bytesToday: client?.snapshot().bytesToday ?? settings.statsBytes,
        allowFakeIp: settings.allowFakeIp,
        openAtLogin: settings.openAtLogin,
        bound,
      };
    });
    ipcMain.handle("desktop:set-base", (event, value: unknown) => {
      if (!fromApp(event)) return { ok: false, error: "拒绝" };
      const parsed = parseBaseInput(value, __VB_DESKTOP_DEV__);
      if (!parsed.ok) return parsed;
      return submitBase(parsed.base);
    });
  }

  async function submitBase(base: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (binding) return { ok: false, error: "正在绑定" };
    binding = true;
    try {
      settings.baseUrl = base;
      flushSettings();
      log.write("base-set", {});
      await stopClient();
      bound = false;
      const store = encryptedTokenStore(tokenFile(), cipher());
      await bindDevice({
        baseUrl: base,
        deviceName: deviceLabel(),
        tokenStore: store,
        onUrl(url) {
          if (!externalAllowed(url, base)) throw new Error("绑定地址被拒绝");
          void shell.openExternal(url);
        },
      });
      const token = await store.read();
      if (!token) throw new Error("换取设备令牌失败");
      await startClient(token);
      log.write("bound", {});
      if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
      return { ok: true };
    } catch (error) {
      log.write("bind-failed", { category: bindCategory(error) });
      return { ok: false, error: publicBindError(error) };
    } finally {
      binding = false;
      renderMenu();
    }
  }
}

function fromApp(event: IpcMainInvokeEvent): boolean {
  const raw = event.senderFrame?.url || event.sender.getURL();
  try {
    const url = new URL(raw);
    return url.protocol === "vbapp:" && url.hostname === "local";
  } catch {
    return false;
  }
}

function serveRenderer(root: string, request: Request): Response {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("forbidden", { status: 403 });
  }
  if (url.hostname !== "local") return new Response("forbidden", { status: 403 });
  const name = url.pathname.replace(/^\/+/, "");
  if (name !== "index.html" && name !== "setup.js" && name !== "setup.css") return new Response("not found", { status: 404 });
  const base = path.resolve(root, "renderer");
  const file = path.resolve(base, name);
  if (file !== path.join(base, name)) return new Response("forbidden", { status: 403 });
  const type = name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
  return new Response(new Uint8Array(readFileSync(file)), {
    headers: { "content-type": type, "content-security-policy": CSP },
  });
}

function hardenSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.webRequest.onBeforeRequest((details, callback) => {
    let protocolName = "";
    try {
      protocolName = new URL(details.url).protocol;
    } catch {
      callback({ cancel: true });
      return;
    }
    callback(protocolName === "vbapp:" ? {} : { cancel: true });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
  });
}

function trayIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const on = dx * dx + dy * dy <= 22;
      const index = (y * size + x) * 4;
      buf[index + 3] = on ? 255 : 0;
    }
  }
  const image = nativeImage.createFromBitmap(buf, { width: size, height: size });
  if (process.platform === "darwin") image.setTemplateImage(true);
  return image;
}

function deviceLabel(): string {
  const name = hostname().replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return name.length > 0 ? name : "这台电脑";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.floor(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function publicBindError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return BIND_ERROR[message] ? message : "绑定失败";
}

function bindCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("加密")) return "encryption";
  if (message.includes("state")) return "state";
  if (message.includes("超时")) return "timeout";
  if (message.includes("令牌")) return "token";
  if (message.includes("绑定地址")) return "origin";
  return "bind";
}
