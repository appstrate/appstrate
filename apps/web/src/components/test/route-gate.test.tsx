// SPDX-License-Identifier: Apache-2.0

/**
 * A layout's gate and the page under it: `/org-settings/billing`
 * without the billing module mounted the settings layout, whose own reads left
 * before the page's gate redirected and aborted them.
 */

import { describe, it, expect } from "bun:test";
import { RouteGate } from "../route-gate.tsx";
import { render } from "../../test/render.tsx";
import { installFakeStorage } from "../../test/fake-storage.ts";

// `RouteGate` reads the module flags off `window.__APP_CONFIG__`: none loaded.
installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const layoutAt = (url: string) =>
  render(
    <RouteGate path="/org-settings">
      <p>layout</p>
    </RouteGate>,
    { initialEntries: [url] },
  );

describe("RouteGate on a layout", () => {
  it("does not mount the layout for a page whose module is not loaded", () => {
    expect(layoutAt("/org-settings/billing")).not.toContain("layout");
  });

  it("mounts it for a page that exists, whatever that page's own gate decides", () => {
    expect(layoutAt("/org-settings/general")).toContain("layout");
    expect(layoutAt("/org-settings")).toContain("layout");
  });
});
