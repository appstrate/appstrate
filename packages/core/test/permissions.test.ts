// SPDX-License-Identifier: Apache-2.0

import { describe, test, expect } from "bun:test";
import { requireModulePermission } from "../src/permissions.ts";

// Augment the resource catalog with a test resource so the helper can be
// invoked with a typed call. Lives only in this test file — no leakage to
// production typings.
declare module "../src/permissions.ts" {
  interface AppstrateModuleResources {
    chat: "read" | "write";
  }
}

function makeContext(perms: Set<string> | undefined | null): {
  get(key: "permissions"): unknown;
} {
  return {
    get(key) {
      if (key === "permissions") return perms ?? undefined;
      return undefined;
    },
  };
}

describe("requireModulePermission", () => {
  test("calls next() when the required permission is present", async () => {
    const middleware = requireModulePermission("chat", "read");
    const c = makeContext(new Set(["chat:read", "chat:write"]));
    let called = false;
    await middleware(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  test("throws when the required permission is missing", async () => {
    const middleware = requireModulePermission("chat", "write");
    const c = makeContext(new Set(["chat:read"]));
    await expect(middleware(c, async () => {})).rejects.toThrow(
      /Insufficient permissions: chat:write required/,
    );
  });

  test("throws when the permissions Set is undefined", async () => {
    const middleware = requireModulePermission("chat", "read");
    const c = makeContext(undefined);
    await expect(middleware(c, async () => {})).rejects.toThrow(/chat:read required/);
  });

  test("throws when c.get returns a non-Set value (defensive against bad pipeline state)", async () => {
    const middleware = requireModulePermission("chat", "read");
    const c = {
      get(_key: string) {
        return "not-a-set" as unknown;
      },
    };
    await expect(middleware(c as never, async () => {})).rejects.toThrow(/chat:read required/);
  });

  test("does not call next() on denial", async () => {
    const middleware = requireModulePermission("chat", "write");
    const c = makeContext(new Set([]));
    let called = false;
    try {
      await middleware(c, async () => {
        called = true;
      });
    } catch {
      // expected
    }
    expect(called).toBe(false);
  });
});
