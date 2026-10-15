// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { render } from "../../test/render.tsx";
import { OverlayProvider } from "../../lib/modal-route.ts";
import { breadcrumbStore } from "../../stores/breadcrumb-store.ts";
import { ShellBreadcrumb } from "../shell-breadcrumb.tsx";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const RUNS = { pathname: "/runs", search: "", hash: "", state: null, key: "runs" };

// A static render reads a store's initial state, so the published layers stand in for it.
let restore = () => {};
beforeEach(() => {
  const { publish } = breadcrumbStore.getState();
  publish("page", "runs", [{ label: "Runs-page-trail" }]);
  publish("overlay", "settings", [{ label: "Settings-trail" }]);
  publish("overlayPage", "webhook", [{ label: "Webhook-trail" }]);
  const snapshot = spyOn(breadcrumbStore, "getInitialState").mockReturnValue(
    breadcrumbStore.getState(),
  );
  restore = () => snapshot.mockRestore();
});
afterEach(() => restore());

describe("ShellBreadcrumb", () => {
  it("draws the page's trail when no overlay is open", () => {
    const html = render(
      <OverlayProvider value={null}>
        <ShellBreadcrumb />
      </OverlayProvider>,
    );
    expect(html).toContain("Runs-page-trail");
    expect(html).not.toContain("Settings-trail");
  });

  it("draws the overlay's trail, extended by the page inside it, while one is open", () => {
    const html = render(
      <OverlayProvider value={{ path: "/workspace-settings/webhooks/wh_1", background: RUNS }}>
        <ShellBreadcrumb />
      </OverlayProvider>,
    );
    expect(html).not.toContain("Runs-page-trail");
    expect(html.indexOf("Settings-trail")).toBeGreaterThan(-1);
    expect(html.indexOf("Webhook-trail")).toBeGreaterThan(html.indexOf("Settings-trail"));
  });
});
