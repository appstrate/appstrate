// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { WebContents } from "electron";
import {
  createTabManager,
  MAX_TABS_PER_RUN,
  MAX_TABS_TOTAL,
  TabError,
  type TabHost,
  type TabManager,
} from "../src/tabs.ts";
import {
  ERR_TAB_FORBIDDEN,
  ERR_TAB_NOT_FOUND,
  ERR_TAB_PAUSED,
  ERR_TAB_QUOTA,
} from "../src/bridge/protocol.ts";

const USER_PARTITION = "persist:appstrate-browser-default";

/**
 * Electron-free host: every surface is a distinct sentinel object, which
 * is all the manager needs (it only ever compares identity and hands the
 * WebContents to the CDP layer).
 */
function fakeHost(): TabHost & { disposed: WebContents[]; activated: (string | null)[] } {
  const disposed: WebContents[] = [];
  const activated: (string | null)[] = [];
  return {
    disposed,
    activated,
    create: (partition) => {
      const webContents = {
        partition,
        getURL: () => "",
        getTitle: () => "",
      } as unknown as WebContents;
      return {
        webContents,
        dispose: (): void => {
          disposed.push(webContents);
        },
      };
    },
    activate: (tabId) => {
      activated.push(tabId);
    },
  };
}

function runTab(tabs: TabManager, runId: string, background = false) {
  return tabs.open({
    owner: { kind: "run", runId },
    partition: `persist:appstrate-agent-${runId}`,
    authorizedUris: ["https://portal.example.com/**"],
    background,
  });
}

describe("tab manager", () => {
  it("activates the first tab and leaves background tabs behind it", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);

    const first = tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION });
    expect(tabs.activeTabId()).toBe(first.tabId);

    const second = runTab(tabs, "run_a", true);
    expect(tabs.activeTabId()).toBe(first.tabId);

    tabs.activate(second.tabId);
    expect(tabs.activeTabId()).toBe(second.tabId);
  });

  it("caps tabs per run and per window", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);

    for (let i = 0; i < MAX_TABS_PER_RUN; i++) runTab(tabs, "run_a", true);
    expect(() => runTab(tabs, "run_a", true)).toThrow(TabError);
    try {
      runTab(tabs, "run_a", true);
    } catch (err) {
      expect((err as TabError).code).toBe(ERR_TAB_QUOTA);
    }

    // A different run still gets its own budget.
    expect(() => runTab(tabs, "run_b", true)).not.toThrow();

    while (tabs.list().length < MAX_TABS_TOTAL) {
      tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION, background: true });
    }
    expect(() =>
      tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION, background: true }),
    ).toThrow(TabError);
  });

  it("refuses a tab owned by the user or by another run", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const userTab = tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION });
    const agentTab = runTab(tabs, "run_a", true);

    expect(() => tabs.require(userTab.tabId, { runId: "run_a" })).toThrow(TabError);
    try {
      tabs.require(userTab.tabId, { runId: "run_a" });
    } catch (err) {
      expect((err as TabError).code).toBe(ERR_TAB_FORBIDDEN);
    }

    try {
      tabs.require(agentTab.tabId, { runId: "run_b" });
    } catch (err) {
      expect((err as TabError).code).toBe(ERR_TAB_FORBIDDEN);
    }

    // Its owner still reaches it, and so does the unattributed (manual) path.
    expect(tabs.require(agentTab.tabId, { runId: "run_a" }).tabId).toBe(agentTab.tabId);
    expect(tabs.require(agentTab.tabId).tabId).toBe(agentTab.tabId);
  });

  it("reports a closed tab as gone", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const tab = runTab(tabs, "run_a");
    tabs.close(tab.tabId);

    try {
      tabs.require(tab.tabId, { runId: "run_a" });
      throw new Error("expected require to throw");
    } catch (err) {
      expect((err as TabError).code).toBe(ERR_TAB_NOT_FOUND);
    }
    expect(host.disposed).toHaveLength(1);
  });

  it("blocks agent commands on a tab the user took over, but still allows closing it", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const tab = runTab(tabs, "run_a");

    expect(tabs.pause(tab.tabId)).toBe(true);
    try {
      tabs.require(tab.tabId, { runId: "run_a" });
      throw new Error("expected require to throw");
    } catch (err) {
      expect((err as TabError).code).toBe(ERR_TAB_PAUSED);
    }
    expect(tabs.require(tab.tabId, { runId: "run_a", allowPaused: true }).tabId).toBe(tab.tabId);

    // A command in flight must never clear a takeover; only the user does.
    tabs.setState(tab.tabId, "idle");
    expect(tabs.get(tab.tabId)?.state).toBe("paused_by_user");

    expect(tabs.resume(tab.tabId)).toBe(true);
    expect(tabs.require(tab.tabId, { runId: "run_a" }).state).toBe("idle");
  });

  it("never pauses a user tab", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const tab = tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION });
    expect(tabs.pause(tab.tabId)).toBe(false);
    expect(tabs.get(tab.tabId)?.state).toBe("idle");
  });

  it("closes only the tabs of the finished run", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const userTab = tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION });
    const a1 = runTab(tabs, "run_a", true);
    const a2 = runTab(tabs, "run_a", true);
    const b1 = runTab(tabs, "run_b", true);

    const closed = tabs.closeForRun("run_a");
    expect(closed.sort()).toEqual([a1.tabId, a2.tabId].sort());
    expect(tabs.get(b1.tabId)).toBeDefined();
    expect(tabs.get(userTab.tabId)).toBeDefined();
    expect(host.disposed).toHaveLength(2);
  });

  it("falls back to another tab when the active one closes", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const first = tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION });
    const second = runTab(tabs, "run_a");
    expect(tabs.activeTabId()).toBe(second.tabId);

    tabs.close(second.tabId);
    expect(tabs.activeTabId()).toBe(first.tabId);

    tabs.close(first.tabId);
    expect(tabs.activeTabId()).toBeNull();
    expect(host.activated.at(-1)).toBeNull();
  });

  it("serializes commands per tab and runs distinct tabs in parallel", async () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const a = runTab(tabs, "run_a", true);
    const b = runTab(tabs, "run_b", true);
    const order: string[] = [];

    const step = (label: string, delayMs: number) => async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(label);
    };

    tabs.chain(a.tabId, step("a1", 20));
    tabs.chain(a.tabId, step("a2", 1));
    tabs.chain(b.tabId, step("b1", 5));

    await new Promise((resolve) => setTimeout(resolve, 80));

    // Same tab keeps its order even though a2 is faster than a1; b1 does
    // not wait behind tab a's queue.
    expect(order.indexOf("a1")).toBeLessThan(order.indexOf("a2"));
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a2"));
  });

  it("keeps the chain alive after a failing step", async () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const tab = runTab(tabs, "run_a");
    const done: string[] = [];

    tabs.chain(tab.tabId, async () => {
      throw new Error("boom");
    });
    tabs.chain(tab.tabId, async () => {
      done.push("after");
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toEqual(["after"]);
  });

  it("lists tabs in insertion order with the active one flagged", () => {
    const host = fakeHost();
    const tabs = createTabManager(host);
    const first = tabs.open({ owner: { kind: "user" }, partition: USER_PARTITION });
    const second = runTab(tabs, "run_a", true);

    const listed = tabs.list();
    expect(listed.map((t) => t.tab_id)).toEqual([first.tabId, second.tabId]);
    expect(listed[0]?.active).toBe(true);
    expect(listed[1]?.owner).toEqual({ kind: "run", runId: "run_a" });
  });
});
