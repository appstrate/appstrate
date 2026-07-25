// SPDX-License-Identifier: Apache-2.0

/**
 * Electron main process entry.
 *
 * Three display modes share one BaseWindow contentView:
 *
 *   webapp (default):
 *     ┌──────────────────────────────────────────────┐
 *     │   Appstrate SPA loaded at ${INSTANCE}        │  ← webappView
 *     │   User interacts with the platform UI here.  │
 *     └──────────────────────────────────────────────┘
 *
 *   split:
 *     ┌────────────────────────┬─────────────────────┐
 *     │ Appstrate SPA          │ agent browser       │
 *     └────────────────────────┴─────────────────────┘
 *
 *   browser:
 *     ┌──────────────────────────────────────────────┐
 *     │ agent browser                                │
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
 * visible. The local chrome opens it beside Appstrate or focuses it
 * across the full content area.
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

// External CDP exposes every renderer and its authenticated session.
// Keep it strictly opt-in for local source builds; packaged apps never
// open a debugging listener.
if (!app.isPackaged && process.env.APPSTRATE_DESKTOP_REMOTE_DEBUG === "1") {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

// Opt-in asynchronous diagnostics. Production does no synchronous disk
// I/O on the Electron main thread.
import { appendFile } from "node:fs";
const debugLogPath = join(app.getPath("logs"), "appstrate-desktop.log");
// Use the product name in development too, where Electron would otherwise
// appear as "Electron". Preserve the already-resolved user-data directory so
// the rename never disconnects existing profiles or browser sessions.
const userDataPath = app.getPath("userData");
app.setName("Appstrate");
app.setPath("userData", userDataPath);
const _debugLog = (msg: string): void => {
  if (process.env.APPSTRATE_DESKTOP_DEBUG_LOG !== "1") return;
  appendFile(debugLogPath, `[${new Date().toISOString()}] ${msg}`, () => {});
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
import { start as startBridge, matchesAuthorizedUri, type BridgeClient } from "./bridge/client.ts";
import { installDownloadInterceptor } from "./bridge/downloads.ts";
import { createTabManager, type TabManager } from "./tabs.ts";
import { clearEphemeralProfile, purgeStaleAgentProfiles } from "./profiles.ts";
import {
  calculateDesktopLayout,
  insetForAgent,
  toggleBrowserFocus,
  togglePanel,
  type ViewMode,
} from "./layout.ts";

let mainWindow: BaseWindow | null = null;
let navView: WebContentsView | null = null;
let webappView: WebContentsView | null = null;
/**
 * Tab registry (protocol 2). `tabViews` maps each tab's WebContents back
 * to the view that hosts it, which is what the layout pass needs; the
 * manager itself stays Electron-agnostic.
 */
let tabManager: TabManager | null = null;
const tabViews = new Map<Electron.WebContents, WebContentsView>();
let activePane: ViewMode = "webapp";
let tray: Tray | null = null;
let bridge: BridgeClient | null = null;
let bridgeState: "connecting" | "connected" | "disconnected" = "disconnected";
/** Last resolved config — kept around so the tray menu can render the
 * profile list without rereading the file on every refresh. */
let currentConfig: Config | null = null;

/**
 * The Appstrate UI and agent-driven browser are separate trust domains.
 * Distinct persistent partitions prevent an agent from navigating to the
 * Appstrate origin and inheriting the UI's Better Auth session.
 */
function persistentPartition(kind: "webapp" | "browser"): string {
  const profile = encodeURIComponent(currentConfig?.defaultProfile ?? "default");
  return `persist:appstrate-${kind}-${profile}`;
}

/**
 * Build a browser tab surface bound to `partition`.
 *
 * Everything the single `browserView` used to get at startup is applied
 * per tab here: denied permissions, no background throttling (a hidden
 * tab whose timers are throttled starves in-page challenges), the
 * download interceptor, and the navigation guard carrying THIS tab's
 * `authorized_uris`.
 */
function createTabSurface(
  win: BaseWindow,
  partition: string,
): { view: WebContentsView; webContents: Electron.WebContents } {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
      // Reports pointer input so a person who only CLICKS in an agent's
      // tab is noticed. Exposes nothing to the page (see the file).
      preload: resolveRendererPath("tab-preload.cjs"),
    },
  });
  const contents = view.webContents;
  denyRemotePermissions(contents.session);
  contents.setBackgroundThrottling(false);
  installDownloadInterceptor(contents.session, _debugLog);
  void contents.loadURL("about:blank");

  // Navigation boundary, per tab. v1 kept a single mutable
  // `activeAuthorizedUris` in the bridge, so the last command's
  // perimeter applied to whatever navigated next; with tabs that would
  // let one run's boundary govern another run's surface.
  contents.on("will-navigate", (event, target) => {
    const tab = tabManager?.byWebContents(contents);
    const allowed = tab?.authorizedUris ?? [];
    if (allowed.length === 0) return;
    if (!allowed.some((spec) => matchesAuthorizedUri(spec, target))) {
      event.preventDefault();
      _debugLog(`[tabs] blocked navigation outside authorized_uris: ${target}\n`);
    }
  });

  // A popup opens a REAL tab now, inheriting the opener's owner,
  // partition and boundary. v1 forced it into the same pane because a
  // detached window was invisible to the bridge; inheritance keeps
  // redirect-based logins (gov auth, OAuth) drivable without ever
  // handing a surface to a different run.
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) return { action: "deny" };
    const opener = tabManager?.byWebContents(contents);
    if (!opener || !tabManager) {
      void contents.loadURL(url);
      return { action: "deny" };
    }
    try {
      const child = tabManager.open({
        owner: opener.owner,
        partition: opener.partition,
        authorizedUris: opener.authorizedUris,
      });
      void child.webContents.loadURL(url);
    } catch {
      // Quota reached — fall back to v1 behaviour rather than losing
      // the navigation entirely.
      void contents.loadURL(url);
    }
    return { action: "deny" };
  });

  // Human takeover detection. Only while the tab is IDLE: the agent's
  // own CDP keystrokes arrive during `driving`, and pausing on those
  // would make every fill look like a takeover.
  contents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown") return;
    const tab = tabManager?.byWebContents(contents);
    if (!tab || tab.owner.kind !== "run" || tab.state !== "idle") return;
    if (tabManager?.pause(tab.tabId)) {
      bridge?.notify("tab.paused", { tab_id: tab.tabId });
      refreshTabStrip();
    }
  });

  const pushUrl = (): void => {
    const tab = tabManager?.byWebContents(contents);
    if (!tab || tabManager?.activeTabId() !== tab.tabId) return;
    navView?.webContents.send("nav:url-changed", contents.getURL());
  };
  contents.on("did-navigate", pushUrl);
  contents.on("did-navigate-in-page", pushUrl);
  contents.on("did-start-loading", () => {
    const tab = tabManager?.byWebContents(contents);
    if (tab && tabManager?.activeTabId() === tab.tabId) {
      navView?.webContents.send("nav:loading-changed", true);
    }
  });
  contents.on("did-stop-loading", () => {
    const tab = tabManager?.byWebContents(contents);
    if (tab && tabManager?.activeTabId() === tab.tabId) {
      navView?.webContents.send("nav:loading-changed", false);
    }
    refreshTabStrip();
  });
  contents.on("page-title-updated", () => refreshTabStrip());

  win.contentView.addChildView(view);
  tabViews.set(contents, view);
  return { view, webContents: contents };
}

/** Push the tab list to the navbar renderer (drives strip + banner). */
function refreshTabStrip(): void {
  if (!tabManager || !navView) return;
  navView.webContents.send("tabs:changed", tabManager.list());
}

/**
 * Colour the frame around the active tab: who is holding this surface.
 *
 * The colour is the WINDOW's background, showing through an inset view.
 * Nothing is injected into the page, so no site can detect the marker
 * and no page CSS can break it — which also matters because the sites
 * agents work on are precisely the ones running bot detection.
 */
const FRAME_NEUTRAL = "#e0e0e0";
const FRAME_AGENT = "#007aff";
const FRAME_WAITING = "#ff9500";

function applyBrowserChrome(): void {
  if (!mainWindow) return;
  const tabId = tabManager?.activeTabId();
  const tab = tabId ? tabManager?.get(tabId) : undefined;
  const colour =
    tab?.owner.kind !== "run"
      ? FRAME_NEUTRAL
      : tab.state === "awaiting_human" || tab.state === "paused_by_user"
        ? FRAME_WAITING
        : FRAME_AGENT;
  mainWindow.contentView.setBackgroundColor(colour);
}

/** The active tab's WebContents, or null when no tab is open. */
function activeTabContents(): Electron.WebContents | null {
  const tabId = tabManager?.activeTabId();
  if (!tabId) return null;
  return tabManager?.get(tabId)?.webContents ?? null;
}

function denyRemotePermissions(ses: Electron.Session): void {
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function createMainWindow(): BaseWindow {
  const win = new BaseWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Appstrate",
    titleBarStyle: "hiddenInset",
    icon: resolveAssetPath("icon.png"),
  });
  win.contentView.setBackgroundColor("#e0e0e0");

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
  navView.webContents.on("did-finish-load", () => applyLayout(win));
  const navbarPath = resolveRendererPath("navbar.html");
  _debugLog(`[main] loading navbar from: ${navbarPath}\n`);
  navView.webContents.loadFile(navbarPath).catch((err) => {
    _debugLog(`[main] loadFile failed: ${err}\n`);
  });

  // Tab registry. Each tab is its own sandboxed WebContentsView bound to
  // the partition the platform minted for it (one profile per agent by
  // default), so no run inherits another's cookies. Downloads are
  // auto-accepted per tab: an agent-ordered one goes to the platform,
  // anything else lands in `~/Documents/AppstrateDesktop/<host>/`.
  tabManager = createTabManager({
    create: (partition) => {
      const { view, webContents } = createTabSurface(win, partition);
      return {
        webContents,
        dispose: (): void => {
          tabViews.delete(webContents);
          win.contentView.removeChildView(view);
          // `WebContentsView` releases its renderer when the underlying
          // WebContents is closed; `close()` is the supported path.
          try {
            webContents.close();
          } catch {
            // already gone
          }
          // Last tab of a run-scoped profile: wipe it, so `isolated`
          // leaves nothing behind. Persistent profiles are kept on
          // purpose and aged out at startup instead.
          if (!tabManager?.usesPartition(partition)) {
            void clearEphemeralProfile(partition, _debugLog);
          }
        },
      };
    },
    activate: (): void => {
      applyLayout(win);
      refreshTabStrip();
    },
  });

  // One user-owned tab so the window is never empty and the navbar
  // always has a target. It is NOT drivable by any run.
  tabManager.open({ owner: { kind: "user" }, partition: persistentPartition("browser") });

  // Webapp view — the Appstrate SPA, loaded into a full Chromium surface.
  // This is what the user actually sees and interacts with: org switcher,
  // agent runs, settings, etc. The browser/navbar pair becomes a secondary
  // pane that only surfaces when an agent is driving the user's browser.
  webappView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: persistentPartition("webapp"),
    },
  });
  denyRemotePermissions(webappView.webContents.session);

  // Default: webapp on TOP, tabs attached UNDERNEATH (never detached —
  // a detached view's document reports visibilityState "hidden" and
  // visibility-gated in-page code like Cloudflare Turnstile refuses to
  // run; see setActivePane). Tab views were already attached by
  // `createTabSurface`; applyLayout owns the z-order from here.
  win.contentView.addChildView(webappView);
  win.contentView.addChildView(navView);

  // Use `win` here because the initial layout runs before the caller
  // assigns the module-level `mainWindow`.
  applyLayout(win);
  win.on("resize", () => applyLayout(win));

  // Per-tab URL/loading pushes are wired in `createTabSurface`; only the
  // panel accelerator is window-wide.
  for (const contents of [navView.webContents, webappView.webContents]) {
    contents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        input.shift &&
        (input.meta || input.control) &&
        input.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        setActivePane(togglePanel(activePane));
      }
    });
  }

  win.on("closed", () => {
    mainWindow = null;
    navView = null;
    webappView = null;
    tabManager?.closeAll();
    tabManager = null;
    tabViews.clear();
  });

  return win;
}

/**
 * Keep all views attached and non-zero-sized so browser automation stays
 * paintable when its panel is closed. Z-order selects the visible surface
 * in the two focused modes; split mode places the surfaces side by side.
 */
function applyLayout(win: BaseWindow): void {
  if (!webappView || !navView) return;
  const bounds = win.getContentBounds();
  const activeTab = tabManager?.activeTabId();
  const activeRecord = activeTab ? tabManager?.get(activeTab) : undefined;
  // ANY waiting agent raises the bar, not just the one in front: it is the
  // only surface a person sees when the browser panel is closed.
  const banner = tabManager?.list().some((tab) => tab.human_request !== undefined) === true;
  const framed = activeRecord?.owner.kind === "run";
  const layout = calculateDesktopLayout(bounds.width, bounds.height, activePane, { banner });
  navView.setBounds(layout.chrome);
  webappView.setBounds(layout.webapp);
  applyBrowserChrome();
  // Every tab keeps the SAME full browser bounds. They are stacked, and
  // only the z-order picks the one on screen — a zero-sized or detached
  // tab would stop painting, which is exactly what breaks the in-page
  // challenges agents have to get through.
  const activeTabId = tabManager?.activeTabId() ?? null;
  const content = win.contentView;
  let activeTabView: WebContentsView | null = null;
  const tabBounds = insetForAgent(layout.browser, framed);
  for (const [contents, view] of tabViews) {
    view.setBounds(tabBounds);
    const tab = tabManager?.byWebContents(contents);
    if (tab && tab.tabId === activeTabId) {
      activeTabView = view;
      continue;
    }
    // Re-adding a child moves it to the top of the stack, so pushing the
    // inactive tabs first leaves the active one above them.
    content.addChildView(view);
  }
  if (activeTabView) content.addChildView(activeTabView);

  if (activePane === "webapp") {
    content.addChildView(webappView);
  } else if (activeTabView) {
    content.addChildView(webappView);
    content.addChildView(activeTabView);
  }
  content.addChildView(navView);
  navView.webContents.send("layout:changed", {
    mode: activePane,
    browserWidth: bounds.width - layout.webapp.width,
  });
}

function setActivePane(next: ViewMode): void {
  if (!mainWindow || !webappView || !navView) return;
  if (activePane === next) return;
  activePane = next;
  applyLayout(mainWindow);
  refreshTray();
}

// IPC: navbar → main process → browserView. Registered once at app
// init time; idempotent across window re-creation since the handlers
// only act when `browserView` is non-null.
function registerNavIpc(): void {
  ipcMain.handle("nav:navigate", async (_evt, url: string): Promise<void> => {
    _debugLog(`[ipc] nav:navigate ${url}\n`);
    const contents = activeTabContents();
    if (!contents || typeof url !== "string") return;
    // Typing an address into an agent-driven tab IS a takeover: the
    // person is steering. Pause it so the run cannot fight them for the
    // page, and let them hand it back explicitly.
    pauseActiveTabIfAgentOwned();
    await contents.loadURL(url).catch((err) => {
      _debugLog(`[ipc] loadURL failed: ${err}\n`);
    });
  });
  ipcMain.handle("nav:back", (): void => {
    const nav = activeTabContents()?.navigationHistory;
    if (nav?.canGoBack()) {
      pauseActiveTabIfAgentOwned();
      nav.goBack();
    }
  });
  ipcMain.handle("nav:forward", (): void => {
    const nav = activeTabContents()?.navigationHistory;
    if (nav?.canGoForward()) {
      pauseActiveTabIfAgentOwned();
      nav.goForward();
    }
  });
  ipcMain.handle("nav:reload", (): void => {
    activeTabContents()?.reload();
  });
  ipcMain.handle("nav:open-devtools", (): void => {
    activeTabContents()?.openDevTools({ mode: "detach" });
  });
  ipcMain.handle("layout:toggle-panel", (): void => {
    setActivePane(togglePanel(activePane));
  });
  ipcMain.handle("layout:toggle-browser-focus", (): void => {
    setActivePane(toggleBrowserFocus(activePane));
  });
  ipcMain.handle("layout:close-browser", (): void => {
    setActivePane("webapp");
  });

  // Pointer input inside a tab (from `tab-preload.cjs`). Same rule as
  // the keyboard path: only an IDLE agent tab is taken over, because a
  // command in flight is the agent's own synthetic input.
  ipcMain.on("tab:pointer-input", (event) => {
    const tab = tabManager?.byWebContents(event.sender);
    if (!tab || tab.owner.kind !== "run" || tab.state !== "idle") return;
    if (tabManager?.pause(tab.tabId)) {
      bridge?.notify("tab.paused", { tab_id: tab.tabId, reason: "user_pointer" });
      refreshTabStrip();
      applyBrowserChrome();
    }
  });

  // Tab strip IPC. The renderer half lands in lot 4; the main-process
  // half is here so the manager stays the single owner of tab state.
  ipcMain.handle("tabs:list", (): unknown => tabManager?.list() ?? []);
  ipcMain.handle("tabs:new", (): void => {
    tabManager?.open({ owner: { kind: "user" }, partition: persistentPartition("browser") });
    refreshTabStrip();
  });
  ipcMain.handle("tabs:select", (_evt, tabId: string): void => {
    if (typeof tabId !== "string") return;
    try {
      tabManager?.activate(tabId);
    } catch (err) {
      _debugLog(`[ipc] tabs:select failed: ${err}\n`);
    }
  });
  ipcMain.handle("tabs:reveal", (_evt, tabId: string): void => {
    if (typeof tabId !== "string") return;
    try {
      tabManager?.activate(tabId);
      if (activePane === "webapp") setActivePane("split");
    } catch (err) {
      _debugLog(`[ipc] tabs:reveal failed: ${err}\n`);
    }
  });
  ipcMain.handle("tabs:close", (_evt, tabId: string): void => {
    if (typeof tabId !== "string") return;
    const tab = tabManager?.get(tabId);
    tabManager?.close(tabId);
    if (tab?.owner.kind === "run") {
      bridge?.notify("tab.closed", { tab_id: tabId, reason: "user_closed" });
    }
    refreshTabStrip();
  });
  ipcMain.handle("tabs:resume", (_evt, tabId: string): void => {
    if (typeof tabId !== "string") return;
    if (tabManager?.resume(tabId)) {
      bridge?.notify("tab.resumed", { tab_id: tabId });
      refreshTabStrip();
    }
  });
}

/**
 * Mark the active tab as taken over when the human drives it through the
 * local chrome. No-op on user-owned tabs (nothing to take over) and on
 * tabs already paused.
 */
function pauseActiveTabIfAgentOwned(): void {
  const tabId = tabManager?.activeTabId();
  if (!tabId) return;
  if (tabManager?.pause(tabId)) {
    bridge?.notify("tab.paused", { tab_id: tabId });
    refreshTabStrip();
  }
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
      label: `View: ${activePane}`,
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
      label: activePane === "webapp" ? "Open browser panel" : "Close browser panel",
      accelerator: "CmdOrCtrl+Shift+B",
      click: (): void => setActivePane(togglePanel(activePane)),
    },
    {
      label: activePane === "browser" ? "Show split view" : "Focus browser",
      enabled: activePane !== "webapp",
      click: (): void => setActivePane(toggleBrowserFocus(activePane)),
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
        activeTabContents()?.openDevTools({ mode: "detach" });
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
  tray.setToolTip(`Appstrate: ${bridgeState}`);
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
  if (!instance || !webappView) return;
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
      title: "Appstrate: Setup",
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
  if (!tabManager) return null;
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
    tabs: tabManager,
    onHumanRequest: (tabId, message): void => {
      // Deliberately NOT stealing the view: the hand-back bar spans both
      // panes, so the request is visible without hijacking what the
      // person is doing. They click "Voir" when they are ready. A system
      // notification covers the window being in the background.
      const agent = tabManager?.get(tabId)?.owner;
      const who = agent?.kind === "run" ? (agent.agentName ?? "An agent") : "An agent";
      void notify(`${who} needs you`, message);
      refreshTabStrip();
      applyBrowserChrome();
    },
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
  if (!tabManager || !webappView) return;
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
  tray.setToolTip("Appstrate");
  // Dock icon (full-color square logo). dock is undefined on Linux/Windows.
  app.dock?.setIcon(nativeImage.createFromPath(resolveAssetPath("icon.png")));
  registerNavIpc();
  refreshTray();
  // Age out profiles of agents nobody has run in a month. Runs BEFORE
  // any tab opens: a profile a live view is bound to must never be
  // deleted under it.
  await purgeStaleAgentProfiles(userDataPath, _debugLog).catch(() => []);
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
  notify("Appstrate: error", msg).catch(() => {});
});
