// SPDX-License-Identifier: Apache-2.0

/**
 * The products toggle: it draws nothing when only one product remains (one choice is no choice),
 * and offers the Chat tab where some space opens the chat and the chat may act (the acting set),
 * whichever space is working and whatever the mode.
 */

import { describe, expect, it } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { ProductTabs } = await import("../product-tabs.tsx");
const { memberSpaceClient, renderInSpace, testSpace } = await import("../../test/space-context.ts");

/** The toggle standing in spc_a over `spaces`, the chat module loaded unless `chat: false`. */
function productTabs(
  spaces: ReturnType<typeof testSpace>[],
  {
    overview = false,
    chat = true,
    seed,
  }: { overview?: boolean; chat?: boolean; seed?: (queryClient: QueryClient) => void } = {},
): string {
  const config = window.__APP_CONFIG__;
  window.__APP_CONFIG__ = { ...config, features: { ...config.features, chat } };
  const queryClient = memberSpaceClient(spaces);
  seed?.(queryClient);
  try {
    return renderInSpace(<ProductTabs />, { queryClient, overview });
  } finally {
    window.__APP_CONFIG__ = config;
  }
}

const space = (id: string, permissions: string[], studio = true) =>
  testSpace(id, permissions, id, { studio });

describe("the products toggle", () => {
  it("is not drawn with the Studio alone (the chat module off)", () => {
    // No space to enter: the permission set is the org's, and the toggle answers at once.
    expect(productTabs([], { chat: false })).toBe("");
  });

  it("draws the Chat tab where a space opens the chat and the chat may act, in every mode", () => {
    const OTHER_ACTING = ["runs:read", "chat:read", "chat:write", "mcp:read"];
    // Two spaces reading runs offer the mode; the other one is where the chat acts.
    const tabs = (
      overview: boolean,
      workingPermissions: string[],
      seedUnread = false,
      otherPermissions = OTHER_ACTING,
    ) =>
      productTabs([space("spc_a", workingPermissions), space("spc_b", otherPermissions)], {
        overview,
        seed: (queryClient) => {
          if (!seedUnread) return;
          // The selected space's list holds one unread reply, « Tous les espaces »'s three.
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
        },
      });
    const chatter = OTHER_ACTING;
    expect(tabs(false, chatter)).toContain('href="/chat"');
    // The chat leads the row; the Studio follows, on its dashboard.
    const row = tabs(false, chatter);
    expect(row.indexOf('href="/chat"')).toBeLessThan(row.indexOf('href="/dashboard"'));
    // A thumb: the toggle is 40 px tall below md.
    expect(tabs(false, chatter)).toContain("desktop-pointer:h-7");
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
    // Out of the mode it counts the selected space's list: one.
    const outOfMode = tabs(false, chatter, true);
    expect(outOfMode).toContain('aria-label="1 conversation non lue"');
    expect(outOfMode).not.toContain("3 conversations non lues");
  });

  it("is not drawn for a role without the Studio: the chat is its one product", () => {
    // Every space withholding the Studio: the Studio tab goes, and a toggle of one is not drawn.
    const chatOnly = ["runs:read", "chat:read", "chat:write", "mcp:read", "agents:run"];
    const spaces = ["spc_a", "spc_b"].map((id) => space(id, chatOnly, false));
    expect(productTabs(spaces)).toBe("");
    expect(productTabs(spaces, { overview: true })).toBe("");
  });
});
