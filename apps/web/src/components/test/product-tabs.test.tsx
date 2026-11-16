// SPDX-License-Identifier: Apache-2.0

/**
 * The products toggle draws nothing when only one product remains: one choice is no choice. The
 * Chat tab is offered where some space opens the chat and the chat may act (the acting set),
 * whichever space is working and whatever the mode.
 */

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
const { spaceStore } = await import("../../stores/space-store.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { overviewStore } = await import("../../stores/overview-store.ts");

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

  it("draws the Chat tab where a space opens the chat and the chat may act, in every mode", () => {
    const OTHER_ACTING = ["runs:read", "chat:read", "chat:write", "mcp:read"];
    const tabs = (
      overview: boolean,
      workingPermissions: string[],
      seedUnread = false,
      otherPermissions = OTHER_ACTING,
    ) => {
      const stubs = [
        spyOn(orgStore, "getInitialState").mockReturnValue({
          ...orgStore.getInitialState(),
          id: "org_1",
        }),
        spyOn(spaceStore, "getInitialState").mockReturnValue({
          ...spaceStore.getInitialState(),
          id: "spc_a",
        }),
        spyOn(authStore, "getInitialState").mockReturnValue({
          ...authStore.getInitialState(),
          user: { id: "u_1", email: "u@example.test", emailVerified: true },
        }),
        spyOn(overviewStore, "getInitialState").mockReturnValue({
          ...overviewStore.getInitialState(),
          chosen: overview ? { "u_1:org_1": true } : {},
        }),
      ];
      const config = window.__APP_CONFIG__;
      window.__APP_CONFIG__ = { ...config, features: { ...config.features, chat: true } };
      const queryClient = new QueryClient();
      queryClient.setQueryData(["orgs"], [ORG]);
      // Two spaces reading runs offer the mode; the other one is where the chat acts.
      const space = (id: string, permissions: string[]) => ({
        id,
        object: "space",
        access: "member",
        permissions,
        personal: false,
        isDefault: id === "spc_a",
        name: id,
        role: null,
      });
      queryClient.setQueryData(
        ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }],
        {
          object: "list",
          hasMore: false,
          data: [space("spc_a", workingPermissions), space("spc_b", otherPermissions)],
        },
      );
      if (seedUnread) {
        // The selected space's list holds one unread reply, « Vue d'ensemble »'s three.
        const list = (unread: number) => ({
          pages: [
            {
              data: Array.from({ length: unread }, (_, i) => ({ id: `chs_${i}`, unread: true })),
              hasMore: false,
            },
          ],
          pageParams: [undefined],
        });
        queryClient.setQueryData(["chat", "sessions", "spc_a"], list(1));
        queryClient.setQueryData(["chat", "sessions", null], list(3));
      }
      try {
        return render(<ProductTabs />, { queryClient });
      } finally {
        window.__APP_CONFIG__ = config;
        for (const stub of stubs) stub.mockRestore();
      }
    };
    const chatter = OTHER_ACTING;
    expect(tabs(false, chatter)).toContain('href="/chat"');
    expect(tabs(true, chatter)).toContain('href="/chat"');
    // The working space opens no chat: offered in either mode, another space opens it and acts.
    expect(tabs(true, ["runs:read"])).toContain('href="/chat"');
    expect(tabs(false, ["runs:read"])).toContain('href="/chat"');
    // Another space opens the chat but the chat cannot act in it (no `mcp:read`): nothing to write.
    const readOnlyElsewhere = ["runs:read", "chat:read", "chat:write"];
    expect(tabs(false, ["runs:read"], false, readOnlyElsewhere)).not.toContain('href="/chat"');
    expect(tabs(true, ["runs:read"], false, readOnlyElsewhere)).not.toContain('href="/chat"');

    // In the mode the chat opens as it is (no space to ask), and its badge counts the
    // overview's list: three unread, which the selected space's filter never sees.
    const inMode = tabs(true, chatter, true);
    expect(inMode).toContain('href="/chat"');
    expect(inMode).toContain('aria-label="3 conversations non lues"');
    expect(tabs(false, chatter, true)).not.toContain("3 conversations non lues");
  });
});
