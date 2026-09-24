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
import {
  requireAnyCeiling,
  requireAnyPermission,
  requireCeiling,
  requirePermission,
} from "../../src/middleware/require-permission.ts";
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

describe("requireAnyPermission", () => {
  const perms = ["agents:write", "skills:write", "integrations:write"];

  it("calls next() when any one of the alternatives is held", async () => {
    for (const held of perms) {
      let called = false;
      await requireAnyPermission(perms)(ctx(new Set([held])), async () => {
        called = true;
      });
      expect(called).toBe(true);
    }
  });

  it("names the whole disjunction on denial, not one arbitrary member", async () => {
    await expect(requireAnyPermission(perms)(ctx(new Set(["agents:read"])), noop)).rejects.toThrow(
      "Insufficient permissions: agents:write|skills:write|integrations:write required",
    );
  });

  it("fails closed when the permissions Set is absent", async () => {
    await expect(requireAnyPermission(perms)(ctx(undefined), noop)).rejects.toThrow(
      /agents:write\|skills:write\|integrations:write required/,
    );
  });

  it("does not call next() on denial", async () => {
    let called = false;
    try {
      await requireAnyPermission(perms)(ctx(new Set()), async () => {
        called = true;
      });
    } catch {
      // expected
    }
    expect(called).toBe(false);
  });
});

describe("requireCeiling", () => {
  const disconnect = requireCeiling("integrations", "disconnect");

  /** A request carrying a credential ceiling and, separately, a role-derived set. */
  function ceilingCtx(ceiling: string[] | undefined, permissions: string[] = []): Context<AppEnv> {
    const values: Record<string, unknown> = {
      scopeCeiling: ceiling && new Set(ceiling),
      permissions: new Set(permissions),
    };
    return { get: (key: string) => values[key] } as unknown as Context<AppEnv>;
  }

  /** Whether the guard let the request through to `next()`. */
  async function passes(c: Context<AppEnv>): Promise<boolean> {
    let called = false;
    await disconnect(c, async () => {
      called = true;
    });
    return called;
  }

  it("passes a request with no ceiling, holding no permission at all", async () => {
    // A cookie session: ownership authorizes it, no role grant is asked.
    expect(await passes(ceilingCtx(undefined))).toBe(true);
  });

  it("passes a ceiling that includes the permission, whatever `permissions` holds", async () => {
    expect(await passes(ceilingCtx(["integrations:disconnect"]))).toBe(true);
  });

  it("refuses a ceiling that omits it, even when `permissions` holds it", async () => {
    const c = ceilingCtx(["integrations:read"], ["integrations:disconnect"]);
    await expect(passes(c)).rejects.toThrow(
      "Insufficient permissions: integrations:disconnect required",
    );
  });

  it("refuses an EMPTY ceiling — empty is a cap, not its absence", async () => {
    await expect(passes(ceilingCtx([]))).rejects.toThrow(/integrations:disconnect required/);
  });
});

describe("requireAnyCeiling", () => {
  const runsRead = requireAnyCeiling(["runs:read", "runs:read-all"]);

  function withCeiling(ceiling: string[] | undefined): Context<AppEnv> {
    const scopeCeiling = ceiling && new Set(ceiling);
    return { get: (key: string) => (key === "scopeCeiling" ? scopeCeiling : undefined) } as never;
  }

  async function passes(c: Context<AppEnv>): Promise<boolean> {
    let called = false;
    await runsRead(c, async () => {
      called = true;
    });
    return called;
  }

  it("passes a request with no ceiling", async () => {
    expect(await passes(withCeiling(undefined))).toBe(true);
  });

  it("passes a ceiling holding any one alternative", async () => {
    expect(await passes(withCeiling(["runs:read"]))).toBe(true);
    expect(await passes(withCeiling(["runs:read-all"]))).toBe(true);
  });

  it("names the whole disjunction when the ceiling holds none", async () => {
    await expect(passes(withCeiling(["agents:run"]))).rejects.toThrow(
      "Insufficient permissions: runs:read|runs:read-all required",
    );
  });

  it("refuses an empty alternative list at construction", () => {
    expect(() => requireAnyCeiling([])).toThrow();
  });
});
