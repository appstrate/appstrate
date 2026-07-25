// SPDX-License-Identifier: Apache-2.0

/**
 * Preload script for the navbar renderer (the small HTML chrome at the
 * top of the main window). Exposes a typed IPC surface so the navbar
 * UI can drive the underlying browser WebContentsView without renderer
 * code touching the main process directly.
 *
 * Kept minimal. Anything more elaborate goes in a v2.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("appstrate", {
  navigate: (url: string): Promise<void> => ipcRenderer.invoke("nav:navigate", url),
  back: (): Promise<void> => ipcRenderer.invoke("nav:back"),
  forward: (): Promise<void> => ipcRenderer.invoke("nav:forward"),
  reload: (): Promise<void> => ipcRenderer.invoke("nav:reload"),
  togglePanel: (): Promise<void> => ipcRenderer.invoke("layout:toggle-panel"),
  toggleBrowserFocus: (): Promise<void> => ipcRenderer.invoke("layout:toggle-browser-focus"),
  closeBrowser: (): Promise<void> => ipcRenderer.invoke("layout:close-browser"),
  onUrlChanged: (cb: (url: string) => void): void => {
    ipcRenderer.on("nav:url-changed", (_event, url: string) => cb(url));
  },
  onLoadingChanged: (cb: (loading: boolean) => void): void => {
    ipcRenderer.on("nav:loading-changed", (_event, loading: boolean) => cb(loading));
  },
  onLayoutChanged: (
    cb: (layout: { mode: "webapp" | "split" | "browser"; browserWidth: number }) => void,
  ): void => {
    ipcRenderer.on("layout:changed", (_event, layout) => cb(layout));
  },
  // Tab strip. The main process owns the tab list; the renderer renders
  // it and sends back intents.
  listTabs: (): Promise<TabSummary[]> => ipcRenderer.invoke("tabs:list"),
  newTab: (): Promise<void> => ipcRenderer.invoke("tabs:new"),
  selectTab: (tabId: string): Promise<void> => ipcRenderer.invoke("tabs:select", tabId),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke("tabs:close", tabId),
  resumeTab: (tabId: string): Promise<void> => ipcRenderer.invoke("tabs:resume", tabId),
  onTabsChanged: (cb: (tabs: TabSummary[]) => void): void => {
    ipcRenderer.on("tabs:changed", (_event, tabs: TabSummary[]) => cb(tabs));
  },
});

/** Mirror of `TabSummary` in `../tabs.ts`, kept local so the preload
 * bundle stays free of main-process imports. */
interface TabSummary {
  tab_id: string;
  owner: { kind: "user" } | { kind: "run"; runId: string; agentName?: string };
  state: "idle" | "driving" | "paused_by_user";
  url: string;
  title: string;
  active: boolean;
}

contextBridge.exposeInMainWorld("appstrateSetup", {
  saveInstance: (payload: { url: string; profile?: string | null }): Promise<void> =>
    ipcRenderer.invoke("setup:save-instance", payload),
});
