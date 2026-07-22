// SPDX-License-Identifier: Apache-2.0

/**
 * Electron main process entry.
 *
 * Two mutually exclusive panes share the BaseWindow contentView:
 *
 *   webapp pane (default, full-window):
 *     ┌──────────────────────────────────────────────┐
 *     │   Appstrate SPA loaded at ${INSTANCE}        │  ← webappView
 *     │   User interacts with the platform UI here.  │
 *     └──────────────────────────────────────────────┘
 *
 *   browser pane (toggled via tray):
 *     ┌──────────────────────────────────────────────┐
 *     │ ← → ↻  [ https://example.com ]   ⟳           │  ← navView
 *     ├──────────────────────────────────────────────┤
 *     │   browserView — agent-controllable surface   │
 *     └──────────────────────────────────────────────┘
 *
 * Authentication lives entirely inside the webapp pane. The user logs
 * into the embedded Appstrate SPA (Better Auth form), the session
 * cookie lands in the WebContentsView's session, the bridge reads it
 * on each (re)connect. No device flow, no JWT, no Keychain — the
 * cookie IS the auth.
 *
 * The bridge keeps a direct reference to `browserView.webContents`, so
 * agent commands execute whether or not the browser pane is currently
 * visible. The user flips to the browser pane via the tray to watch the
 * agent work.
 *
 * Lifecycle:
 *   1. App ready → read the instance URL from config (or prompt via
 *      setup window on first launch).
 *   2. Create the main window with both panes (webapp visible).
 *   3. Point webappView at ${INSTANCE} so the SPA loads. If the user is
 *      already logged in (persisted cookie), the SPA shows the dashboard;
 *      otherwise the SPA renders its own login form.
 *   4. Build a tray icon (status + pane toggle + DevTools per pane).
 *   5. Start the bridge — it reads the cookie from the webapp pane's
 *      session and sits in `disconnected` until the user finishes
 *      signing in, then auto-connects on the next backoff tick.
 */

import {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  Tray,
  Menu,
  Notification,
  nativeImage,
  shell,
} from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `__dirname` is a CommonJS global — not defined under ESM (tsconfig
// emits ESM since the package is `"type": "module"`). Derive it from
// import.meta.url so the navbar HTML + preload paths resolve correctly.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a renderer HTML file's absolute path. The renderer/ folder is
 * copied to dist/renderer/ at build time (see package.json `build`
 * script) so the same code path works in dev (when running tsc-compiled
 * output from dist/) and in a packaged .app (where everything lives
 * inside Contents/Resources/app/dist/).
 */
function resolveRendererPath(filename: string): string {
  return join(__dirname, "renderer", filename);
}

/**
 * Resolve an asset file's absolute path. The assets/ folder is copied
 * to dist/assets/ at build time (see package.json `build` script) so
 * the same code path works in dev (loading from dist/) and inside a
 * packaged .app (everything under Contents/Resources/app/dist/).
 */
function resolveAssetPath(filename: string): string {
  return join(__dirname, "assets", filename);
}

// Enable Chromium's remote debugging port so external tooling (Chrome
// MCP, Playwright, raw CDP clients) can attach to the BrowserView with
// the user's logged-in session intact. MUST be set before app.whenReady.
// POC scope: hardcoded port 9222 + bound to localhost only via the
// default Electron behaviour. For a shipped app this would be opt-in.
app.commandLine.appendSwitch("remote-debugging-port", "9222");
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");

// POC debug: tee everything to a tail-able file regardless of how
// Electron is launched (GUI apps don't reliably print to stdout).
import { appendFileSync } from "node:fs";
const _debugLog = (msg: string): void => {
  try {
    appendFileSync("/tmp/electron-debug.log", `[${new Date().toISOString()}] ${msg}`);
  } catch {
    // best-effort
  }
};
import {
  readConfigFile,
  activeInstance,
  touchActiveProfile,
  upsertAndSwitchProfile,
  switchProfile,
  normalizeInstance,
  suggestProfileName,
  type Config,
} from "./config.ts";
import { start as startBridge, type BridgeClient } from "./bridge/client.ts";
import { installDownloadInterceptor } from "./bridge/downloads.ts";

const NAVBAR_HEIGHT = 44;

type ActivePane = "webapp" | "browser";

let mainWindow: BaseWindow | null = null;
let navView: WebContentsView | null = null;
let browserView: WebContentsView | null = null;
let webappView: WebContentsView | null = null;
let activePane: ActivePane = "webapp";
let tray: Tray | null = null;
let bridge: BridgeClient | null = null;
let bridgeState: "connecting" | "connected" | "disconnected" = "disconnected";
/** Last resolved config — kept around so the tray menu can render the
 * profile list without rereading the file on every refresh. */
let currentConfig: Config | null = null;

function createMainWindow(): BaseWindow {
  const win = new BaseWindow({
    width: 1200,
    height: 800,
    title: "Appstrate Desktop",
    icon: resolveAssetPath("icon.png"),
  });

  // Navbar view — small HTML chrome at the top, talks to main via IPC.
  // contextIsolation + a preload script keep the renderer-to-main channel
  // narrow and typed (see preload.ts).
  //
  // `sandbox: false` is required for ESM preloads (Electron ≥28 supports
  // ESM preload only when the renderer is unsandboxed — sandboxed renderers
  // load CommonJS preloads only). The navbar renderer is local trusted
  // HTML so unsandboxing it is safe; the browserView below stays sandboxed.
  navView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload.js"),
    },
  });
  // dist/main.js sits next to src/renderer/navbar.html at build time?
  // No — tsc only compiles .ts, the HTML stays in src/. Load it from
  // the source tree relative to this file's compiled location:
  // __dirname = .../apps/desktop/dist → ../src/renderer/navbar.html
  // POC debug: forward all navbar renderer console output (and load
  // failures) to the main-process stdout so iteration on the nav UI
  // doesn't require opening DevTools every restart.
  navView.webContents.on("console-message", (event) => {
    _debugLog(`[navbar:${event.level}] ${event.message}\n`);
  });
  navView.webContents.on("did-fail-load", (_evt, code, desc, url) => {
    _debugLog(`[navbar] did-fail-load (${code}) ${desc} url=${url}\n`);
  });
  const navbarPath = resolveRendererPath("navbar.html");
  _debugLog(`[main] loading navbar from: ${navbarPath}\n`);
  navView.webContents.loadFile(navbarPath).catch((err) => {
    _debugLog(`[main] loadFile failed: ${err}\n`);
  });

  // Browser view — what the agent + user both drive. Sandboxed,
  // no nodeIntegration. The bridge talks to this view's webContents
  // directly from the main process (no IPC).
  browserView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browserView.webContents.loadURL("about:blank");

  // Auto-accept downloads. Any `<a download>` click or programmatic
  // download triggered by the agent (or the user) lands in
  // `~/Documents/AppstrateDesktop/<site-host>/` without a save dialog.
  // POC scope: no allowlist by site, no concurrency cap, no overwrite
  // protection. A shipped app would gate this per-site and surface a
  // tray notification per completed download.
  installDownloadInterceptor(browserView.webContents.session, _debugLog);

  // Webapp view — the Appstrate SPA, loaded into a full Chromium surface.
  // This is what the user actually sees and interacts with: org switcher,
  // agent runs, settings, etc. The browser/navbar pair becomes a secondary
  // pane that only surfaces when an agent is driving the user's browser.
  webappView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Default: webapp visible, browser+navbar hidden. The bridge still drives
  // browserView's webContents even when it's not in the view tree — the
  // user can flip to the browser pane via the tray to watch the agent work.
  win.contentView.addChildView(webappView);

  // Use `win` (closure) instead of `mainWindow` (module-level) — these
  // helpers run inside createMainWindow's initial layout() call before
  // the caller assigns `mainWindow = createMainWindow()`. Referencing
  // `mainWindow` here would silently bail out and leave views at 0×0.
  const layoutWebapp = (): void => {
    if (!webappView) return;
    const bounds = win.getContentBounds();
    webappView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  };
  const layoutBrowser = (): void => {
    if (!navView || !browserView) return;
    const bounds = win.getContentBounds();
    navView.setBounds({ x: 0, y: 0, width: bounds.width, height: NAVBAR_HEIGHT });
    browserView.setBounds({
      x: 0,
      y: NAVBAR_HEIGHT,
      width: bounds.width,
      height: bounds.height - NAVBAR_HEIGHT,
    });
  };
  const layout = (): void => {
    if (activePane === "webapp") layoutWebapp();
    else layoutBrowser();
  };
  layout();
  win.on("resize", layout);

  // Push URL + loading state updates to the navbar renderer so the URL
  // bar reflects reality regardless of whether the user, the agent, or
  // an in-page navigation triggered the change.
  const sendUrl = (): void => {
    if (!navView || !browserView) return;
    navView.webContents.send("nav:url-changed", browserView.webContents.getURL());
  };
  browserView.webContents.on("did-navigate", sendUrl);
  browserView.webContents.on("did-navigate-in-page", sendUrl);
  browserView.webContents.on("did-start-loading", () => {
    navView?.webContents.send("nav:loading-changed", true);
  });
  browserView.webContents.on("did-stop-loading", () => {
    navView?.webContents.send("nav:loading-changed", false);
  });

  win.on("closed", () => {
    mainWindow = null;
    navView = null;
    browserView = null;
    webappView = null;
  });

  return win;
}

/**
 * Swap the visible pane between the webapp SPA (default) and the
 * agent-controlled browser. The hidden pane is fully detached from the
 * view tree (not just covered) so it doesn't intercept input or eat
 * compositor cycles. The bridge keeps a direct reference to
 * `browserView.webContents` so agent commands still execute even when
 * the user is on the webapp pane — they just don't see them happen
 * until they flip back.
 */
function setActivePane(next: ActivePane): void {
  if (!mainWindow || !webappView || !navView || !browserView) return;
  if (activePane === next) return;
  const content = mainWindow.contentView;
  if (next === "webapp") {
    content.removeChildView(navView);
    content.removeChildView(browserView);
    content.addChildView(webappView);
  } else {
    content.removeChildView(webappView);
    content.addChildView(navView);
    content.addChildView(browserView);
  }
  activePane = next;
  const bounds = mainWindow.getContentBounds();
  if (next === "webapp") {
    webappView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  } else {
    navView.setBounds({ x: 0, y: 0, width: bounds.width, height: NAVBAR_HEIGHT });
    browserView.setBounds({
      x: 0,
      y: NAVBAR_HEIGHT,
      width: bounds.width,
      height: bounds.height - NAVBAR_HEIGHT,
    });
  }
  refreshTray();
}

// IPC: navbar → main process → browserView. Registered once at app
// init time; idempotent across window re-creation since the handlers
// only act when `browserView` is non-null.
function registerNavIpc(): void {
  ipcMain.handle("nav:navigate", async (_evt, url: string): Promise<void> => {
    _debugLog(`[ipc] nav:navigate ${url}\n`);
    if (!browserView || typeof url !== "string") return;
    await browserView.webContents.loadURL(url).catch((err) => {
      _debugLog(`[ipc] loadURL failed: ${err}\n`);
    });
  });
  ipcMain.handle("nav:back", (): void => {
    const nav = browserView?.webContents.navigationHistory;
    if (nav?.canGoBack()) nav.goBack();
  });
  ipcMain.handle("nav:forward", (): void => {
    const nav = browserView?.webContents.navigationHistory;
    if (nav?.canGoForward()) nav.goForward();
  });
  ipcMain.handle("nav:reload", (): void => {
    browserView?.webContents.reload();
  });
  ipcMain.handle("nav:open-devtools", (): void => {
    browserView?.webContents.openDevTools({ mode: "detach" });
  });
}

function buildTrayMenu(): Menu {
  // Build the "Switch instance" submenu from the currently-loaded
  // config. The active profile is disabled (clicking it would be a
  // no-op relaunch); switching to any other triggers a relaunch into
  // that profile's context. "Add new instance…" pops the same setup
  // form the first-launch path uses.
  const profileNames = currentConfig ? Object.keys(currentConfig.profiles).sort() : [];
  const activeProfileName = currentConfig?.defaultProfile ?? null;
  const switchInstanceSubmenu: Electron.MenuItemConstructorOptions[] = [
    ...profileNames.map((name): Electron.MenuItemConstructorOptions => ({
      label:
        name === activeProfileName
          ? `${name}  (active)`
          : `${name}  →  ${currentConfig?.profiles[name]?.instance ?? ""}`,
      enabled: name !== activeProfileName,
      click: (): void => void switchToProfileAndRelaunch(name),
    })),
    ...(profileNames.length > 0 ? [{ type: "separator" as const }] : []),
    {
      label: "Add new instance…",
      click: (): void => void addInstanceAndRelaunch(),
    },
  ];

  return Menu.buildFromTemplate([
    {
      label: `Instance: ${activeProfileName ?? "—"}`,
      enabled: false,
    },
    {
      label: `Bridge: ${bridgeState}`,
      enabled: false,
    },
    {
      label: `Active pane: ${activePane}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Show main window",
      click: (): void => {
        if (!mainWindow) mainWindow = createMainWindow();
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: "Switch to webapp pane",
      enabled: activePane !== "webapp",
      click: (): void => setActivePane("webapp"),
    },
    {
      label: "Switch to browser pane",
      enabled: activePane !== "browser",
      click: (): void => setActivePane("browser"),
    },
    { type: "separator" },
    {
      label: "Switch instance",
      submenu: switchInstanceSubmenu,
    },
    {
      label: "Open Appstrate dashboard in default browser",
      click: async (): Promise<void> => {
        const cfg = currentConfig ?? (await readConfigFile());
        const instance = cfg ? activeInstance(cfg) : null;
        if (instance) await shell.openExternal(instance);
      },
    },
    {
      label: "Open browser pane DevTools",
      accelerator: "CmdOrCtrl+Alt+I",
      click: (): void => {
        browserView?.webContents.openDevTools({ mode: "detach" });
      },
    },
    {
      label: "Open webapp pane DevTools",
      click: (): void => {
        webappView?.webContents.openDevTools({ mode: "detach" });
      },
    },
    { type: "separator" },
    {
      label: "Sign out",
      click: async (): Promise<void> => {
        await signOut();
        refreshTray();
      },
    },
    { type: "separator" },
    { label: "Quit", role: "quit" },
  ]);
}

function refreshTray(): void {
  if (!tray) return;
  tray.setToolTip(`Appstrate Desktop — ${bridgeState}`);
  tray.setContextMenu(buildTrayMenu());
}

/**
 * Sign-out flow:
 *   1. Stop the bridge so the WS closes immediately (no orphan
 *      connection authenticated with about-to-be-cleared cookies).
 *   2. Clear the webapp pane's session cookies for the configured
 *      instance.
 *   3. Reload the webapp so the SPA sees the missing session and
 *      renders its own login form — otherwise the user still sees the
 *      dashboard until they navigate, with no surface signal that they
 *      were signed out.
 *   4. Restart the bridge so it sits in `disconnected` and auto-picks
 *      up the new session as soon as the user signs in again.
 */
async function signOut(): Promise<void> {
  bridge?.stop();
  bridge = null;
  bridgeState = "disconnected";
  const cfg = currentConfig ?? (await readConfigFile());
  const instance = cfg ? activeInstance(cfg) : null;
  if (!instance || !webappView || !browserView) return;
  try {
    const host = new URL(instance).hostname;
    const cookies = await webappView.webContents.session.cookies.get({ domain: host });
    _debugLog(`[signout] clearing ${cookies.length} cookies for ${host}\n`);
    await Promise.all(
      cookies.map((c) =>
        // Reconstruct the URL the cookie was set on (Electron's
        // session.cookies.remove requires a url, not a domain). Pick the
        // most permissive scheme — `secure=1` cookies were set on https,
        // others on http; the remove call is scheme-tolerant in practice.
        webappView!.webContents.session.cookies.remove(
          `${c.secure ? "https" : "http"}://${host}${c.path}`,
          c.name,
        ),
      ),
    );
    // Reload so the SPA sees the missing cookie and shows its login form.
    await webappView.webContents.loadURL(instance);
  } catch (err) {
    _debugLog(`[signout] cookie clear failed: ${err}\n`);
  }
  // Restart the bridge — it'll sit in `disconnected` and auto-pick up
  // the new session cookie as soon as the user signs back in.
  bridge = startBridgeFor(instance);
}

async function notify(title: string, body: string): Promise<void> {
  new Notification({ title, body }).show();
}

let setupWindow: BrowserWindow | null = null;

/**
 * Show the setup form. Used for first-launch (collect URL + profile
 * label, write config) AND for "Add new instance" from the tray
 * (append a profile to an existing config). On submit, upserts the
 * named profile and switches to it. Returns the resulting config so
 * callers can keep using `activeInstance()` consistently.
 *
 * Never resolves if the user closes the window without submitting
 * (the close handler rejects).
 */
function showSetupWindow(): Promise<Config> {
  return new Promise<Config>((resolve, reject) => {
    setupWindow = new BrowserWindow({
      width: 480,
      height: 480,
      title: "Appstrate Desktop — Setup",
      icon: resolveAssetPath("icon.png"),
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        preload: join(__dirname, "preload.js"),
      },
    });
    setupWindow.loadFile(resolveRendererPath("setup.html")).catch((err) => {
      _debugLog(`[setup] loadFile failed: ${err}\n`);
      reject(err);
    });
    setupWindow.on("closed", () => {
      setupWindow = null;
      reject(new Error("setup window closed before submit"));
    });

    // One-shot IPC handler — removed after the first submit so a stale
    // listener doesn't survive into the next launch. The setup form may
    // submit either `{ url }` (legacy single-field shape) or
    // `{ url, profile }` (new shape). We accept both.
    ipcMain.handleOnce(
      "setup:save-instance",
      async (_evt, payload: string | { url: string; profile?: string }): Promise<void> => {
        const rawUrl = typeof payload === "string" ? payload : payload.url;
        const profileName =
          typeof payload === "object" && payload.profile?.trim() ? payload.profile.trim() : null;
        const normalized = normalizeInstance(rawUrl);
        const name = profileName ?? suggestProfileName(normalized);
        const cfg = await upsertAndSwitchProfile(name, normalized);
        setupWindow?.removeAllListeners("closed");
        setupWindow?.close();
        setupWindow = null;
        resolve(cfg);
      },
    );
  });
}

/**
 * Resolve the Appstrate instance URL to point the webapp pane at. No
 * auth here — authentication is delegated to the embedded SPA's own
 * login flow.
 */
async function ensureInstanceConfigured(): Promise<{
  config: Config;
  instance: string;
} | null> {
  let cfg = await readConfigFile();
  // Migration path: APPSTRATE_INSTANCE env var bootstraps the default
  // profile on first launch if no config exists yet. After that, the
  // env var is ignored — the persisted profile owns the source of truth.
  if (!cfg && process.env.APPSTRATE_INSTANCE) {
    const instance = normalizeInstance(process.env.APPSTRATE_INSTANCE);
    cfg = await upsertAndSwitchProfile(suggestProfileName(instance), instance);
  }
  if (!cfg) {
    // First launch — pop the setup UI to collect URL + profile name.
    try {
      cfg = await showSetupWindow();
    } catch (err) {
      _debugLog(`[setup] aborted: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  }
  const instance = activeInstance(cfg);
  if (!instance) {
    _debugLog(
      `[setup] active profile "${cfg.defaultProfile}" has no instance — corrupted config\n`,
    );
    return null;
  }
  await touchActiveProfile(cfg).catch(() => {});
  return { config: cfg, instance };
}

/**
 * Open a fresh bridge for the given instance, wired up to read cookies
 * from the webapp pane's session on every (re)connect. Both bootstrap()
 * and signOut() use this — signOut needs a fresh bridge so the user can
 * re-login in the webapp pane and have the bridge auto-pick up the new
 * session cookie without restarting the app.
 *
 * We filter cookies by `domain` instead of `url` because the Better Auth
 * session cookie is set with the `Secure` flag, and Electron's url-based
 * filter excludes Secure cookies when the URL scheme is http (which it
 * is during local dev). Domain filter ignores scheme and returns every
 * cookie scoped to the host. The receiving server checks the cookie
 * value, not its transport scheme.
 */
function startBridgeFor(instance: string): BridgeClient | null {
  if (!browserView) return null;
  return startBridge({
    instance,
    getCookieHeader: async (): Promise<string | null> => {
      if (!webappView) return null;
      try {
        const host = new URL(instance).hostname;
        const cookies = await webappView.webContents.session.cookies.get({ domain: host });
        _debugLog(
          `[bridge] cookies for domain=${host}: count=${cookies.length} names=[${cookies.map((c) => `${c.name}(${c.value.length},sec=${c.secure ? 1 : 0})`).join(",")}]\n`,
        );
        if (cookies.length === 0) return null;
        return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      } catch (err) {
        _debugLog(`[bridge] cookies.get failed: ${err}\n`);
        return null;
      }
    },
    webContents: browserView.webContents,
    onStateChange: (state): void => {
      bridgeState = state;
      refreshTray();
    },
    onError: (err): void => {
      const msg = err instanceof Error ? err.message : String(err);
      _debugLog(`[bridge] error: ${msg}\n`);
    },
  });
}

async function bootstrap(): Promise<void> {
  const resolved = await ensureInstanceConfigured();
  if (!resolved) {
    refreshTray();
    return;
  }
  const { config, instance } = resolved;
  currentConfig = config;
  mainWindow ??= createMainWindow();
  if (!browserView || !webappView) return;
  // Point the webapp pane at the configured instance. The SPA either
  // shows the dashboard (cookie present) or its own login form.
  webappView.webContents.loadURL(instance).catch((err) => {
    _debugLog(`[main] webapp loadURL failed: ${err}\n`);
  });
  bridge = startBridgeFor(instance);
  refreshTray();
}

/**
 * Switch the active profile and relaunch. Simpler than hot-reloading
 * the webapp pane + restarting the bridge from scratch: a relaunch
 * starts every subsystem in the new instance's context cleanly. The
 * cookies for the new instance's host are already in Chromium's
 * session store (or absent, in which case the SPA renders its login
 * form on next start).
 */
async function switchToProfileAndRelaunch(name: string): Promise<void> {
  try {
    await switchProfile(name);
  } catch (err) {
    _debugLog(`[switch] failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  app.relaunch();
  app.exit(0);
}

/**
 * Open the setup window to add a new instance, then switch + relaunch.
 * Reuses the same setup window the first-launch flow uses; the only
 * difference is that we're not blocked on it (the existing window can
 * stay open until the relaunch happens).
 */
async function addInstanceAndRelaunch(): Promise<void> {
  try {
    await showSetupWindow();
  } catch (err) {
    _debugLog(`[add-instance] aborted: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  // showSetupWindow already upserted + switched the profile.
  app.relaunch();
  app.exit(0);
}

app.whenReady().then(async () => {
  // Tray icon — the Appstrate brand mark. Resized to 22x22 so macOS
  // renders it crisply in the menu bar at 1× and (since the source is
  // 96×96) clean at 2× too. `setTemplateImage(true)` lets macOS render
  // the icon in the current menu bar text color (black in light mode,
  // white in dark mode), using each pixel's luminance as alpha. The
  // existing colored PNG has good alpha + dark shapes, so this works
  // reasonably out of the box. If the colored bolt looks washed out in
  // light mode, swap in a purpose-built monochrome PNG.
  const trayIcon = nativeImage
    .createFromPath(resolveAssetPath("tray-icon.png"))
    .resize({ width: 22, height: 22 });
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip("Appstrate Desktop");
  // Dock icon (full-color square logo). dock is undefined on Linux/Windows.
  app.dock?.setIcon(nativeImage.createFromPath(resolveAssetPath("icon.png")));
  registerNavIpc();
  refreshTray();
  await bootstrap();
});

app.on("window-all-closed", () => {
  // Keep the app alive in the tray even when the main window closes —
  // the bridge keeps running so the agent can re-open a window on demand.
  // POC: just stop quitting; bridge stays connected. Quit via the tray.
});

app.on("before-quit", () => {
  bridge?.stop();
});

// One window at a time. If the user re-launches, focus the existing one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) mainWindow = createMainWindow();
    mainWindow.show();
    mainWindow.focus();
  });
}

// macOS: re-create the window when the dock icon is clicked and no
// windows are open. Same single-window invariant.
app.on("activate", () => {
  if (!mainWindow) mainWindow = createMainWindow();
  mainWindow.show();
});

// Defensive global handler — unhandled promise rejections in main process
// would otherwise log to stderr and disappear silently in production. For
// the POC, surface them as notifications so iteration is faster.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  notify("Appstrate Desktop — error", msg).catch(() => {});
});
