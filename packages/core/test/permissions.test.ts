// SPDX-License-Identifier: Apache-2.0

import { describe, test, expect, afterEach } from "bun:test";
import {
  requireModulePermission,
  requireCorePermission,
  setPermissionDenialHandler,
  CORE_RESOURCE_NAMES,
  type CoreResources,
} from "../src/permissions.ts";

// Augment the resource catalog with a test resource so the helper can be
// invoked with a typed call. Lives only in this test file — no leakage to
// production typings.
declare module "../src/permissions.ts" {
  interface ModuleResources {
    tasks: "read" | "write";
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
    const middleware = requireModulePermission("tasks", "read");
    const c = makeContext(new Set(["tasks:read", "tasks:write"]));
    let called = false;
    await middleware(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  test("throws when the required permission is missing", async () => {
    const middleware = requireModulePermission("tasks", "write");
    const c = makeContext(new Set(["tasks:read"]));
    await expect(middleware(c, async () => {})).rejects.toThrow(
      /Insufficient permissions: tasks:write required/,
    );
  });

  test("throws when the permissions Set is undefined", async () => {
    const middleware = requireModulePermission("tasks", "read");
    const c = makeContext(undefined);
    await expect(middleware(c, async () => {})).rejects.toThrow(/tasks:read required/);
  });

  test("throws when c.get returns a non-Set value (defensive against bad pipeline state)", async () => {
    const middleware = requireModulePermission("tasks", "read");
    const c = {
      get(_key: string) {
        return "not-a-set" as unknown;
      },
    };
    await expect(middleware(c as never, async () => {})).rejects.toThrow(/tasks:read required/);
  });

  test("does not call next() on denial", async () => {
    const middleware = requireModulePermission("tasks", "write");
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

describe("requireCorePermission", () => {
  // Same fail-closed semantics as requireModulePermission, typed against
  // CoreResources instead. These tests lock down the contract so
  // a future "let's unify the two helpers" refactor can't silently change
  // the throw shape consumers depend on.

  test("calls next() when the required core permission is present", async () => {
    const middleware = requireCorePermission("agents", "run");
    const c = makeContext(new Set(["agents:run", "agents:read"]));
    let called = false;
    await middleware(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  test("throws when the required core permission is missing", async () => {
    const middleware = requireCorePermission("agents", "run");
    const c = makeContext(new Set(["agents:read"]));
    await expect(middleware(c, async () => {})).rejects.toThrow(
      /Insufficient permissions: agents:run required/,
    );
  });

  test("throws when the permissions Set is undefined", async () => {
    const middleware = requireCorePermission("runs", "cancel");
    const c = makeContext(undefined);
    await expect(middleware(c, async () => {})).rejects.toThrow(/runs:cancel required/);
  });

  test("does not call next() on denial", async () => {
    const middleware = requireCorePermission("agents", "delete");
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

// ---------------------------------------------------------------------------
// Audit handler isolation — a throwing denial hook must NOT escalate a 403
// into a 500 (which would mask the authz denial and change the client-facing
// error shape). Locks the try/catch semantics of `makePermissionGuard`.
// ---------------------------------------------------------------------------

describe("setPermissionDenialHandler — fault isolation", () => {
  afterEach(() => {
    setPermissionDenialHandler(null);
  });

  test("throwing audit handler is swallowed; the middleware still throws Insufficient permissions", async () => {
    setPermissionDenialHandler(() => {
      throw new Error("audit sink down");
    });
    const middleware = requireModulePermission("tasks", "read");
    const c = makeContext(new Set([]));
    await expect(middleware(c, async () => {})).rejects.toThrow(
      /Insufficient permissions: tasks:read required/,
    );
  });

  test("handler is invoked exactly once per denial with the required permission", async () => {
    const calls: string[] = [];
    setPermissionDenialHandler((ctx) => {
      calls.push(ctx.required);
    });
    const middleware = requireCorePermission("agents", "delete");
    const c = makeContext(new Set([]));
    await expect(middleware(c, async () => {})).rejects.toThrow(/agents:delete/);
    expect(calls).toEqual(["agents:delete"]);
  });

  test("handler is NOT invoked when the permission is granted", async () => {
    let invoked = false;
    setPermissionDenialHandler(() => {
      invoked = true;
    });
    const middleware = requireCorePermission("agents", "run");
    const c = makeContext(new Set(["agents:run"]));
    await middleware(c, async () => {});
    expect(invoked).toBe(false);
  });
});

describe("CoreResources ↔ CORE_RESOURCE_NAMES drift", () => {
  // The interface is the compile-time vocabulary; CORE_RESOURCE_NAMES is
  // the runtime collision-detection Set the platform's module loader
  // reads to reject any module that re-declares a core resource.
  //
  // They MUST list the same resource names — drift would mean either
  // (a) a core resource exists at the type level but a module can still
  // claim it at runtime (security hole), or (b) the loader rejects a
  // resource that core doesn't actually own (false positive blocking
  // legitimate modules). Both are silent failures without this test.

  test("every keyof CoreResources is in CORE_RESOURCE_NAMES", () => {
    // Materialize the interface keys via a typed dictionary literal —
    // adding a resource to CoreResources without listing it here
    // is a TS error, so this catches drift in BOTH directions in one
    // assertion.
    const allCoreResources: Record<keyof CoreResources, true> = {
      org: true,
      members: true,
      agents: true,
      skills: true,
      tools: true,
      providers: true,
      runs: true,
      schedules: true,
      memories: true,
      connections: true,
      profiles: true,
      "app-profiles": true,
      models: true,
      "provider-keys": true,
      proxies: true,
      "api-keys": true,
      applications: true,
      "end-users": true,
      "credential-proxy": true,
    };
    for (const name of Object.keys(allCoreResources)) {
      expect(CORE_RESOURCE_NAMES.has(name)).toBe(true);
    }
  });

  test("CORE_RESOURCE_NAMES has no extra entries beyond the interface", () => {
    const allCoreResources: Record<keyof CoreResources, true> = {
      org: true,
      members: true,
      agents: true,
      skills: true,
      tools: true,
      providers: true,
      runs: true,
      schedules: true,
      memories: true,
      connections: true,
      profiles: true,
      "app-profiles": true,
      models: true,
      "provider-keys": true,
      proxies: true,
      "api-keys": true,
      applications: true,
      "end-users": true,
      "credential-proxy": true,
    };
    const interfaceNames = new Set(Object.keys(allCoreResources));
    for (const name of CORE_RESOURCE_NAMES) {
      expect(interfaceNames.has(name)).toBe(true);
    }
    expect(CORE_RESOURCE_NAMES.size).toBe(interfaceNames.size);
  });
});
