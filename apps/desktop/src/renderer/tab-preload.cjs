// SPDX-License-Identifier: Apache-2.0

/**
 * Preload for agent-driven tabs — the click half of takeover detection.
 *
 * Electron reports keyboard input to the main process (`before-input-event`)
 * but nothing for the mouse, so a person who only CLICKS in an agent's tab
 * (ticking a box, clearing a visual challenge) went unnoticed and the agent
 * kept working underneath them. This closes that gap.
 *
 * CommonJS on purpose: these tabs are sandboxed, and a sandboxed renderer
 * loads CJS preloads only (ESM preload requires `sandbox: false`, which we
 * will not do for pages an agent visits).
 *
 * Nothing is exposed to the page. `contextIsolation` keeps this world
 * separate, no bridge is created, and the listener is passive + capture so
 * it can neither block nor alter what the site receives. The site cannot
 * detect it either: no DOM is touched and no property is patched.
 */

const { ipcRenderer } = require("electron");

let lastSignal = 0;

/**
 * Throttled: a takeover is a state change, not a stream. One IPC per
 * 250 ms is enough to flip the tab, and a person clicking through a form
 * must not flood the main process.
 */
function signalPointer() {
  const now = Date.now();
  if (now - lastSignal < 250) return;
  lastSignal = now;
  ipcRenderer.send("tab:pointer-input");
}

// `pointerdown` covers mouse, trackpad, pen and touch in one event, and
// capture phase means a page that swallows events cannot hide the click.
window.addEventListener("pointerdown", signalPointer, { capture: true, passive: true });
