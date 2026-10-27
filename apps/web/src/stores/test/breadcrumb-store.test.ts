// SPDX-License-Identifier: Apache-2.0

/**
 * The page beneath an overlay, the overlay and a page inside the overlay each
 * own a layer of the header trail: none can wipe another's, and the header
 * shows the overlay's while one is open.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { breadcrumbStore, visibleTrail } from "../breadcrumb-store.ts";

const { publish, clear } = breadcrumbStore.getState();
const labels = (overlayOpen: boolean) =>
  visibleTrail(breadcrumbStore.getState(), overlayOpen).map((entry) => entry.label);

beforeEach(() => {
  for (const layer of ["page", "overlay", "overlayPage"] as const) {
    breadcrumbStore.setState({ [layer]: { owner: null, entries: [] } });
  }
});

describe("breadcrumb layers", () => {
  it("shows the page's trail without an overlay and the overlay's over it", () => {
    publish("page", "runs", [{ label: "Runs" }]);
    publish("overlay", "settings", [{ label: "Settings", href: "/org-settings" }]);

    expect(labels(false)).toEqual(["Runs"]);
    expect(labels(true)).toEqual(["Settings"]);
  });

  it("extends the overlay's trail with a page inside it, whichever publishes first", () => {
    // Effects run child first: the webhook page publishes before the settings layout.
    publish("overlayPage", "webhook", [{ label: "https://hooks.example/a" }]);
    publish("overlay", "settings", [
      { label: "Settings", href: "/org-settings" },
      { label: "Workspace", href: "/workspace-settings/general" },
      { label: "Webhooks", href: "/workspace-settings/webhooks" },
    ]);

    expect(labels(true)).toEqual(["Settings", "Workspace", "Webhooks", "https://hooks.example/a"]);
  });

  it("clears only the unmounting writer's own layer", () => {
    publish("page", "runs", [{ label: "Runs" }]);
    publish("overlay", "settings", [{ label: "Settings" }]);
    publish("overlayPage", "webhook", [{ label: "hook" }]);

    clear("overlayPage", "webhook");
    expect(labels(true)).toEqual(["Settings"]);

    clear("overlay", "settings");
    expect(labels(true)).toEqual([]);
    expect(labels(false)).toEqual(["Runs"]);
  });

  it("leaves a layer a newer writer took over", () => {
    publish("page", "runs", [{ label: "Runs" }]);
    publish("page", "run-detail", [{ label: "Runs", href: "/runs" }, { label: "#12" }]);

    clear("page", "runs");
    expect(labels(false)).toEqual(["Runs", "#12"]);
  });

  it("shows the page's current trail once the overlay closes, not its trail at opening", () => {
    publish("page", "run", [{ label: "#12" }]);
    publish("overlay", "settings", [{ label: "Settings" }]);
    publish("page", "run", [{ label: "#13" }]);
    clear("overlay", "settings");

    expect(labels(false)).toEqual(["#13"]);
  });

  it("republishes an entry that becomes a slot under the same label", () => {
    publish("page", "chat", [{ label: "Thread" }]);
    publish("page", "chat", [{ label: "Thread", slot: true }]);

    expect(breadcrumbStore.getState().page.entries[0]!.slot).toBe(true);
  });

  it("leaves the store untouched when nothing changed", () => {
    publish("page", "runs", [{ label: "Runs", href: "/runs" }]);
    const before = breadcrumbStore.getState();
    publish("page", "runs", [{ label: "Runs", href: "/runs" }]);

    expect(breadcrumbStore.getState()).toBe(before);
  });
});
