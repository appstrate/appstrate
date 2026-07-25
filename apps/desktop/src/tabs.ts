// SPDX-License-Identifier: Apache-2.0

/**
 * Tab registry — the desktop half of the multi-tab bridge (protocol 2).
 *
 * v1 drove ONE `WebContentsView`, so "the browser" and "the surface a run
 * pilots" were the same object. v2 splits them: the window hosts N tabs,
 * each with its own owner, its own session partition and its own
 * `authorized_uris` boundary.
 *
 * Ownership is the load-bearing concept:
 *
 *   { kind: "user" }              a tab the human opened. NEVER drivable.
 *   { kind: "run", runId, … }     a tab a run opened via `tabs.open`.
 *
 * A run only ever drives tabs it opened. There is no adoption, no
 * transfer, no "take over the current tab" — the platform mints the tab
 * with the run's partition and boundary, and both are frozen for the
 * tab's lifetime (Chromium fixes the session at view-creation time, so
 * the partition physically cannot change afterwards).
 *
 * Electron contact is confined to the injected `TabHost`: this module
 * owns the bookkeeping (identity, ownership, state, quotas, ordering)
 * and stays unit-testable without an Electron runtime.
 */

import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import {
  ERR_TAB_FORBIDDEN,
  ERR_TAB_NOT_FOUND,
  ERR_TAB_PAUSED,
  ERR_TAB_QUOTA,
} from "./bridge/protocol.ts";

/** Defence in depth — the platform enforces its own quota first. */
export const MAX_TABS_TOTAL = 8;
export const MAX_TABS_PER_RUN = 3;

export type TabOwner = { kind: "user" } | { kind: "run"; runId: string; agentName?: string };

/**
 * `idle` — owned but not currently executing a command.
 * `driving` — a command is in flight.
 * `paused_by_user` — the human took over; agent commands are refused
 *   until they hand it back. This is the hybrid mode: a person clears
 *   what the agent cannot (hardware 2FA, SSO, an anti-bot challenge).
 */
export type TabState = "idle" | "driving" | "paused_by_user";

export interface TabRecord {
  tabId: string;
  owner: TabOwner;
  state: TabState;
  partition: string;
  authorizedUris: readonly string[];
  webContents: WebContents;
  dispose(): void;
}

/** Wire-shaped summary (snake_case) returned by `tabs.list`. */
export interface TabSummary {
  tab_id: string;
  owner: TabOwner;
  state: TabState;
  url: string;
  title: string;
  active: boolean;
}

export interface TabSurface {
  webContents: WebContents;
  /** Detach from the window and release the renderer process. */
  dispose(): void;
}

export interface TabHost {
  /** Create + attach a surface bound to `partition`. */
  create(partition: string): TabSurface;
  /** Bring `tabId` to the front (z-order); `null` when no tab is left. */
  activate(tabId: string | null): void;
}

export class TabError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "TabError";
  }
}

export interface OpenTabOptions {
  owner: TabOwner;
  partition: string;
  authorizedUris?: readonly string[];
  /** Open without stealing focus from the current tab. */
  background?: boolean;
}

export interface TabManager {
  open(options: OpenTabOptions): TabRecord;
  close(tabId: string): void;
  /**
   * Throws `TabError` when the tab is gone, paused, or owned elsewhere.
   * `allowPaused` is for lifecycle verbs (close, activate): a tab the
   * user took over can still be closed by its owning run.
   */
  require(tabId: string, opts?: { runId?: string; allowPaused?: boolean }): TabRecord;
  get(tabId: string): TabRecord | undefined;
  byWebContents(wc: WebContents): TabRecord | undefined;
  list(): TabSummary[];
  activate(tabId: string): void;
  activeTabId(): string | null;
  pause(tabId: string): boolean;
  resume(tabId: string): boolean;
  setState(tabId: string, state: TabState): void;
  closeForRun(runId: string): string[];
  closeAll(): void;
  /** Per-tab command chain — see `bridge/client.ts` for why. */
  chain(tabId: string, step: () => Promise<void>): void;
}

export function createTabManager(host: TabHost): TabManager {
  const tabs = new Map<string, TabRecord>();
  /**
   * Insertion order drives the tab strip, so it must survive close +
   * reopen. A separate array keeps that explicit rather than relying on
   * Map iteration order surviving future refactors.
   */
  const order: string[] = [];
  const chains = new Map<string, Promise<void>>();
  let active: string | null = null;

  function countForRun(runId: string): number {
    let n = 0;
    for (const tab of tabs.values()) {
      if (tab.owner.kind === "run" && tab.owner.runId === runId) n++;
    }
    return n;
  }

  function open(options: OpenTabOptions): TabRecord {
    if (tabs.size >= MAX_TABS_TOTAL) {
      throw new TabError(ERR_TAB_QUOTA, `tab limit reached (${MAX_TABS_TOTAL} open)`);
    }
    if (options.owner.kind === "run" && countForRun(options.owner.runId) >= MAX_TABS_PER_RUN) {
      throw new TabError(
        ERR_TAB_QUOTA,
        `run ${options.owner.runId} already owns ${MAX_TABS_PER_RUN} tabs`,
      );
    }
    const tabId = `tab_${randomUUID()}`;
    const surface = host.create(options.partition);
    const record: TabRecord = {
      tabId,
      owner: options.owner,
      state: "idle",
      partition: options.partition,
      authorizedUris: options.authorizedUris ?? [],
      webContents: surface.webContents,
      dispose: surface.dispose,
    };
    tabs.set(tabId, record);
    order.push(tabId);
    if (!options.background || active === null) {
      active = tabId;
      host.activate(tabId);
    }
    return record;
  }

  function close(tabId: string): void {
    const record = tabs.get(tabId);
    if (!record) return;
    tabs.delete(tabId);
    chains.delete(tabId);
    const index = order.indexOf(tabId);
    if (index >= 0) order.splice(index, 1);
    try {
      record.dispose();
    } catch {
      // The renderer may already be gone (window closed, crash) — the
      // bookkeeping removal above is what actually matters.
    }
    if (active === tabId) {
      active = order.length > 0 ? order[order.length - 1]! : null;
      host.activate(active);
    }
  }

  function require(tabId: string, opts?: { runId?: string; allowPaused?: boolean }): TabRecord {
    const record = tabs.get(tabId);
    if (!record) throw new TabError(ERR_TAB_NOT_FOUND, `unknown or closed tab: ${tabId}`);
    // A user tab is never drivable, and a run never reaches another
    // run's tab. The platform enforces this first; repeating it here
    // means a bug (or a forged frame) on that side cannot cross the
    // boundary on this one.
    if (opts?.runId !== undefined) {
      if (record.owner.kind !== "run" || record.owner.runId !== opts.runId) {
        throw new TabError(ERR_TAB_FORBIDDEN, `tab ${tabId} is not owned by this run`);
      }
    }
    if (record.state === "paused_by_user" && opts?.allowPaused !== true) {
      throw new TabError(ERR_TAB_PAUSED, `tab ${tabId} was taken over by the user`);
    }
    return record;
  }

  return {
    open,
    close,
    require,
    get: (tabId) => tabs.get(tabId),
    byWebContents: (wc) => {
      for (const tab of tabs.values()) {
        if (tab.webContents === wc) return tab;
      }
      return undefined;
    },
    list: () =>
      order.flatMap((tabId): TabSummary[] => {
        const tab = tabs.get(tabId);
        if (!tab) return [];
        return [
          {
            tab_id: tab.tabId,
            owner: tab.owner,
            state: tab.state,
            url: safe(() => tab.webContents.getURL(), ""),
            title: safe(() => tab.webContents.getTitle(), ""),
            active: tab.tabId === active,
          },
        ];
      }),
    activate: (tabId) => {
      if (!tabs.has(tabId)) throw new TabError(ERR_TAB_NOT_FOUND, `unknown tab: ${tabId}`);
      active = tabId;
      host.activate(tabId);
    },
    activeTabId: () => active,
    pause: (tabId) => {
      const tab = tabs.get(tabId);
      // Only an agent-owned tab can be "taken over" — a user tab was
      // never driven in the first place.
      if (!tab || tab.owner.kind !== "run" || tab.state === "paused_by_user") return false;
      tab.state = "paused_by_user";
      return true;
    },
    resume: (tabId) => {
      const tab = tabs.get(tabId);
      if (!tab || tab.state !== "paused_by_user") return false;
      tab.state = "idle";
      return true;
    },
    setState: (tabId, state) => {
      const tab = tabs.get(tabId);
      // Never let a command transition out of `paused_by_user`: only an
      // explicit user hand-back (resume) clears a takeover.
      if (!tab || tab.state === "paused_by_user") return;
      tab.state = state;
    },
    closeForRun: (runId) => {
      const closed = order.filter((tabId) => {
        const tab = tabs.get(tabId);
        return tab?.owner.kind === "run" && tab.owner.runId === runId;
      });
      for (const tabId of closed) close(tabId);
      return closed;
    },
    closeAll: () => {
      for (const tabId of [...order]) close(tabId);
    },
    /**
     * Serialize per tab, not globally. Commands on one tab must stay
     * strictly ordered (they share a transient CDP debugger attached to
     * that `webContents`, and a second command would detach it from under
     * the first), while two tabs progress in parallel — the whole point
     * of protocol 2.
     */
    chain: (tabId, step) => {
      const previous = chains.get(tabId) ?? Promise.resolve();
      // A failing step must not poison the queue: callers turn errors
      // into JSON-RPC error responses themselves, so the chain only
      // owns ordering. Swallowing here also keeps a rejected link from
      // surfacing as an unhandled rejection.
      const next = previous.then(step, step).catch(() => {});
      chains.set(tabId, next);
      void next.finally(() => {
        // Drop the chain once it drains so a long-lived process doesn't
        // accumulate resolved promises for closed tabs.
        if (chains.get(tabId) === next) chains.delete(tabId);
      });
    },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
