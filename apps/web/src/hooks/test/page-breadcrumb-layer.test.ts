// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { pageBreadcrumbLayer } from "../use-overlay-breadcrumb.ts";

describe("pageBreadcrumbLayer", () => {
  it("puts a page inside the open overlay on the overlay's trail", () => {
    const webhook = "/workspace-settings/webhooks/wh_1";
    expect(pageBreadcrumbLayer(webhook, webhook)).toBe("overlayPage");
  });

  it("keeps the page beneath an overlay, and any page without one, on the page trail", () => {
    expect(pageBreadcrumbLayer("/runs", "/workspace-settings/webhooks/wh_1")).toBe("page");
    expect(pageBreadcrumbLayer("/runs", null)).toBe("page");
  });
});
