// SPDX-License-Identifier: Apache-2.0

/**
 * Unit contract for the apps/api-internal `requirePermission` wrapper.
 *
 * `requirePermission`, `requireCorePermission` and `requireModulePermission`
 * all share ONE runtime path (`makePermissionGuard` in
 * `@appstrate/core/permissions`), so a change to that path silently changes all
 * three. The two typed core helpers are pinned in
 * `packages/core/test/permissions.test.ts`; this file pins the third, which
 * otherwise has no coverage below the route-level RBAC integration suite
 * (`test/integration/middleware/require-permission.test.ts`).
 *
 * The claim under test is exact-string membership: the guard grants on
 * `resource:action` verbatim and on nothing else — no aliasing, no prefix
 * match, no per-resource special case.
 */

import { describe, it, expect } from "bun:test";
import type { Context, Next } from "hono";
import { requirePermission } from "../../src/middleware/require-permission.ts";
import type { AppEnv } from "../../src/types/index.ts";

/** Minimal Hono-context stand-in — the guard only reads `c.get("permissions")`. */
function ctx(perms: Set<string> | undefined): Context<AppEnv> {
  return {
    get(key: string) {
      return key === "permissions" ? perms : undefined;
    },
  } as unknown as Context<AppEnv>;
}

const noop: Next = async () => {};

describe("requirePermission", () => {
  it("calls next() when the exact permission string is present", async () => {
    const middleware = requirePermission("files", "read");
    let called = false;
    await middleware(ctx(new Set(["files:read", "runs:read"])), async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("denies when only a neighbouring action on the same resource is granted", async () => {
    const middleware = requirePermission("files", "delete");
    await expect(middleware(ctx(new Set(["files:read"])), noop)).rejects.toThrow(
      /Insufficient permissions: files:delete required/,
    );
  });

  it("denies on any spelling other than the required one — no alias, no prefix match", async () => {
    const middleware = requirePermission("files", "read");
    for (const spelling of ["documents:read", "file:read", "files", "files:read:extra"]) {
      await expect(middleware(ctx(new Set([spelling])), noop)).rejects.toThrow(
        /Insufficient permissions: files:read required/,
      );
    }
  });

  it("fails closed when the permissions Set is absent", async () => {
    const middleware = requirePermission("agents", "run");
    await expect(middleware(ctx(undefined), noop)).rejects.toThrow(/agents:run required/);
  });

  it("does not call next() on denial", async () => {
    const middleware = requirePermission("agents", "delete");
    let called = false;
    try {
      await middleware(ctx(new Set()), async () => {
        called = true;
      });
    } catch {
      // expected
    }
    expect(called).toBe(false);
  });
});
