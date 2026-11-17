// SPDX-License-Identifier: Apache-2.0

/** The products toggle draws nothing when only one product remains: one choice is no choice. */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { render } = await import("../../test/render.tsx");
const { ProductTabs } = await import("../product-tabs.tsx");
const { orgStore } = await import("../../stores/org-store.ts");

const ORG = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  icon: null,
  color: null,
  role: "member",
  deleting_at: null,
  permissions: [],
  createdAt: "2026-09-05T00:00:00Z",
};

describe("the products toggle", () => {
  it("is not drawn with the Studio alone (the chat module off)", () => {
    const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
      ...orgStore.getInitialState(),
      id: "org_1",
    });
    const queryClient = new QueryClient();
    queryClient.setQueryData(["orgs"], [ORG]);
    // No space to enter: the permission set is the org's, and the toggle answers at once.
    queryClient.setQueryData(
      ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
      { object: "list", hasMore: false, data: [] },
    );
    try {
      expect(render(<ProductTabs />, { queryClient })).toBe("");
    } finally {
      snapshot.mockRestore();
    }
  });
});
