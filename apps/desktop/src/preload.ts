// SPDX-License-Identifier: Apache-2.0

/**
 * Preload script for the navbar renderer (the small HTML chrome at the
 * top of the main window). Exposes a typed IPC surface so the navbar
 * UI can drive the underlying browser WebContentsView without renderer
 * code touching the main process directly.
 *
 * Kept minimal — five methods total. Anything more elaborate goes in
 * a v2.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("appstrate", {
  navigate: (url: string): Promise<void> => ipcRenderer.invoke("nav:navigate", url),
  back: (): Promise<void> => ipcRenderer.invoke("nav:back"),
  forward: (): Promise<void> => ipcRenderer.invoke("nav:forward"),
  reload: (): Promise<void> => ipcRenderer.invoke("nav:reload"),
  onUrlChanged: (cb: (url: string) => void): void => {
    ipcRenderer.on("nav:url-changed", (_event, url: string) => cb(url));
  },
  onLoadingChanged: (cb: (loading: boolean) => void): void => {
    ipcRenderer.on("nav:loading-changed", (_event, loading: boolean) => cb(loading));
  },
});

contextBridge.exposeInMainWorld("appstrateSetup", {
  saveInstance: (payload: { url: string; profile?: string | null }): Promise<void> =>
    ipcRenderer.invoke("setup:save-instance", payload),
});
