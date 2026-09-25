// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import {
  requireModulePermission,
  requireCorePermission,
  makePermissionGuard,
  setPermissionDenialHandler,
  agentCapabilities,
  canReadRuns,
  canRunAgents,
  packagePermission,
  packageSightPermissions,
  reaches,
  spacePackagePermission,
  CORE_RESOURCE_ACTIONS,
  CORE_RESOURCE_LEVELS,
  CORE_RESOURCE_NAMES,
  ORG_LEVEL_PERMISSIONS,
  PERMISSION_REQUIREMENT_MARKER,
  SPACE_LEVEL_PERMISSIONS,
  type CoreResources,
  type RunLevel,
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
  it("calls next() when the required permission is present", async () => {
    const middleware = requireModulePermission("tasks", "read");
    const c = makeContext(new Set(["tasks:read", "tasks:write"]));
    let called = false;
    await middleware(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("throws when the required permission is missing", async () => {
    const middleware = requireModulePermission("tasks", "write");
    const c = makeContext(new Set(["tasks:read"]));
    await expect(middleware(c, async () => {})).rejects.toThrow(
      /Insufficient permissions: tasks:write required/,
    );
  });

  it("throws when the permissions Set is undefined", async () => {
    const middleware = requireModulePermission("tasks", "read");
    const c = makeContext(undefined);
    await expect(middleware(c, async () => {})).rejects.toThrow(/tasks:read required/);
  });

  it("throws when c.get returns a non-Set value (defensive against bad pipeline state)", async () => {
    const middleware = requireModulePermission("tasks", "read");
    const c = {
      get(_key: string) {
        return "not-a-set" as unknown;
      },
    };
    await expect(middleware(c as never, async () => {})).rejects.toThrow(/tasks:read required/);
  });

  it("does not call next() on denial", async () => {
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

  it("calls next() when the required core permission is present", async () => {
    const middleware = requireCorePermission("agents", "run");
    const c = makeContext(new Set(["agents:run", "agents:read"]));
    let called = false;
    await middleware(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("throws when the required core permission is missing", async () => {
    const middleware = requireCorePermission("agents", "run");
    const c = makeContext(new Set(["agents:read"]));
    await expect(middleware(c, async () => {})).rejects.toThrow(
      /Insufficient permissions: agents:run required/,
    );
  });

  it("throws when the permissions Set is undefined", async () => {
    const middleware = requireCorePermission("runs", "cancel");
    const c = makeContext(undefined);
    await expect(middleware(c, async () => {})).rejects.toThrow(/runs:cancel required/);
  });

  it("does not call next() on denial", async () => {
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

  it("throwing audit handler is swallowed; the middleware still throws Insufficient permissions", async () => {
    setPermissionDenialHandler(() => {
      throw new Error("audit sink down");
    });
    const middleware = requireModulePermission("tasks", "read");
    const c = makeContext(new Set([]));
    await expect(middleware(c, async () => {})).rejects.toThrow(
      /Insufficient permissions: tasks:read required/,
    );
  });

  it("handler is invoked exactly once per denial with the required permission", async () => {
    const calls: string[] = [];
    setPermissionDenialHandler((ctx) => {
      calls.push(ctx.required);
    });
    const middleware = requireCorePermission("agents", "delete");
    const c = makeContext(new Set([]));
    await expect(middleware(c, async () => {})).rejects.toThrow(/agents:delete/);
    expect(calls).toEqual(["agents:delete"]);
  });

  it("handler is NOT invoked when the permission is granted", async () => {
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

describe("CoreResources ↔ runtime catalog drift", () => {
  // The interface is the compile-time vocabulary; CORE_RESOURCE_ACTIONS is
  // the runtime mirror the level sets and the module loader's
  // collision-detection Set are both derived from.
  //
  // They MUST list the same resource names AND the same actions — drift
  // would mean either (a) a core resource/action exists at the type level
  // but no permission string is ever produced for it, or (b) the loader
  // rejects a resource core doesn't actually own. Both are silent failures
  // without this test. The resource half is a compile error (the `satisfies`
  // clause plus the exhaustive record below); the action half is the
  // `Exclude` assertion.

  it("every keyof CoreResources is in CORE_RESOURCE_NAMES", () => {
    // Materialize the interface keys via a typed dictionary literal —
    // adding a resource to CoreResources without listing it here
    // is a TS error, so this catches drift in BOTH directions in one
    // assertion.
    const allCoreResources: Record<keyof CoreResources, true> = {
      org: true,
      members: true,
      roles: true,
      "space-settings": true,
      "space-members": true,
      agents: true,
      skills: true,
      "mcp-servers": true,
      runs: true,
      files: true,
      schedules: true,
      persistence: true,
      models: true,
      "model-provider-credentials": true,
      proxies: true,
      "api-keys": true,
      spaces: true,
      "end-users": true,
      "credential-proxy": true,
      "llm-proxy": true,
      integrations: true,
    };
    const interfaceNames = Object.keys(allCoreResources);
    for (const name of interfaceNames) {
      expect(CORE_RESOURCE_NAMES.has(name)).toBe(true);
    }
    expect(CORE_RESOURCE_NAMES.size).toBe(interfaceNames.length);
  });

  it("every action declared on CoreResources appears in CORE_RESOURCE_ACTIONS", () => {
    // Compile-time: an action present on the interface but missing from the
    // runtime table widens `MissingAction` away from `never`, which makes the
    // annotation below unsatisfiable.
    type MissingAction = {
      [R in keyof CoreResources]: Exclude<
        CoreResources[R],
        (typeof CORE_RESOURCE_ACTIONS)[R][number]
      >;
    }[keyof CoreResources];
    const noMissingAction: [MissingAction] extends [never] ? true : false = true;
    expect(noMissingAction).toBe(true);
  });
});

describe("permission levels", () => {
  const everyPermission = Object.entries(CORE_RESOURCE_ACTIONS).flatMap(([resource, actions]) =>
    (actions as readonly string[]).map((action) => `${resource}:${action}`),
  );

  it("every CoreResource has a level", () => {
    for (const resource of CORE_RESOURCE_NAMES) {
      expect(["org", "space"]).toContain(CORE_RESOURCE_LEVELS[resource as keyof CoreResources]);
    }
    expect(Object.keys(CORE_RESOURCE_LEVELS).length).toBe(CORE_RESOURCE_NAMES.size);
  });

  it("the two level sets are disjoint and cover the whole catalog", () => {
    for (const permission of everyPermission) {
      const inOrg = ORG_LEVEL_PERMISSIONS.has(permission as never);
      const inSpace = SPACE_LEVEL_PERMISSIONS.has(permission as never);
      // Exactly one — a permission in both would be granted twice, a
      // permission in neither would be ungrantable by any role.
      expect([inOrg, inSpace].filter(Boolean).length).toBe(1);
    }
    expect(ORG_LEVEL_PERMISSIONS.size + SPACE_LEVEL_PERMISSIONS.size).toBe(everyPermission.length);
  });

  it("api-keys is space-level and llm-proxy is org-level", () => {
    // The two resources whose level is not obvious from their name: keys are
    // bound to a space (`api_keys.space_id NOT NULL`), the LLM proxy is
    // metered per org and is not space-scoped.
    expect(CORE_RESOURCE_LEVELS["api-keys"]).toBe("space");
    expect(CORE_RESOURCE_LEVELS["llm-proxy"]).toBe("org");
    expect(CORE_RESOURCE_LEVELS["credential-proxy"]).toBe("space");
  });
});

// ---------------------------------------------------------------------------
// The requirement stamp — read off Hono's route table to derive what an RBAC
// set makes structurally possible. A guard that stopped carrying it would make
// its operation look unguarded, i.e. granted to everyone.
// ---------------------------------------------------------------------------

function stampedRequirement(guard: object): unknown {
  return Object.getOwnPropertyDescriptor(guard, PERMISSION_REQUIREMENT_MARKER)?.value;
}

function stampedMarker(guard: object): unknown {
  return Object.getOwnPropertyDescriptor(guard, Symbol.for("appstrate.permissionGuard"))?.value;
}

describe("permission requirement stamp", () => {
  it("carries the exact string the guard tests membership of", () => {
    expect(stampedRequirement(requireCorePermission("agents", "write"))).toBe("agents:write");
    expect(stampedRequirement(requireModulePermission("tasks", "read"))).toBe("tasks:read");
  });

  it("still carries the boolean guard marker other code reads", () => {
    expect(stampedMarker(requireCorePermission("agents", "write"))).toBe(true);
    expect(stampedMarker(makePermissionGuard("runs:read"))).toBe(true);
  });
});

describe("canReadRuns / canRunAgents", () => {
  const has =
    (...permissions: string[]) =>
    (permission: string) =>
      permissions.includes(permission);

  it("runs:read alone opens the run read surfaces", () => {
    expect(canReadRuns(has("runs:read"))).toBe(true);
  });

  it("runs:read-all alone opens them too — it is the wider permission", () => {
    expect(canReadRuns(has("runs:read-all"))).toBe(true);
  });

  it("neither form means no run read at all", () => {
    expect(canReadRuns(has("runs:cancel", "agents:run"))).toBe(false);
  });

  it("agents:run without run-read is not running agents", () => {
    expect(canRunAgents(has("agents:run"))).toBe(false);
  });

  it("run-read without agents:run is not running agents", () => {
    expect(canRunAgents(has("runs:read-all"))).toBe(false);
  });

  it("both together is, under either read form", () => {
    expect(canRunAgents(has("agents:run", "runs:read"))).toBe(true);
    expect(canRunAgents(has("agents:run", "runs:read-all"))).toBe(true);
  });
});

describe("packagePermission / packageSightPermissions", () => {
  it("spells each family's permission on its own resource", () => {
    expect(packagePermission("agent", "read")).toBe("agents:read");
    expect(packagePermission("mcp-server", "write")).toBe("mcp-servers:write");
    expect(packagePermission("integration", "share")).toBe("integrations:share");
  });

  it("lets `agents:run` see an agent, and nothing else of a package family", () => {
    expect(packageSightPermissions("agent")).toEqual(["agents:read", "agents:run"]);
    expect(packageSightPermissions("skill")).toEqual(["skills:read"]);
    expect(packageSightPermissions("integration")).toEqual(["integrations:read"]);
    expect(packageSightPermissions("mcp-server")).toEqual(["mcp-servers:read"]);
  });
});

describe("spacePackagePermission", () => {
  it("asks each family's activation grant, spelled as role data", () => {
    const acts = ["activate", "configure", "deactivate"] as const;
    const table = Object.fromEntries(
      (["agent", "skill", "mcp-server", "integration"] as const).map((type) => [
        type,
        acts.map((op) => spacePackagePermission(type, op)),
      ]),
    );
    expect(table).toEqual({
      agent: ["agents:configure", "agents:configure", "agents:configure"],
      skill: ["skills:write", "skills:write", "skills:write"],
      "mcp-server": ["mcp-servers:write", "mcp-servers:write", "mcp-servers:write"],
      integration: ["integrations:install", "integrations:install", "integrations:uninstall"],
    });
  });
});

/**
 * `agentCapabilities` is the one place "how far does this caller get with runs"
 * is decided — the MCP tool set, the server `instructions`, the chat persona and
 * the web access chip all read its answer. So it is pinned exhaustively, against
 * a spec written out longhand below rather than against the predicates it calls:
 * re-spelling them here is what makes a dropped conjunct show up as a
 * disagreement instead of as two copies of the same mistake.
 */
describe("agentCapabilities", () => {
  /** Every permission the derivation reads. */
  const UNIVERSE = ["agents:run", "agents:write", "runs:read", "runs:read-all"] as const;

  /** The rules, spelled out: no helper, no shared subexpression with the source. */
  function spec(
    held: ReadonlySet<string>,
    invokes: boolean,
  ): { runLevel: RunLevel; authors: boolean } {
    const readsRuns = held.has("runs:read") || held.has("runs:read-all");
    const launches = held.has("agents:run") && readsRuns;
    const composes = launches && held.has("agents:write");
    const runLevel: RunLevel = !invokes
      ? "none"
      : composes
        ? "compose"
        : launches
          ? "run"
          : readsRuns
            ? "read"
            : "none";
    return { runLevel, authors: invokes && held.has("agents:write") };
  }

  it("agrees with the spec on every subset it reads, dispatching or not", () => {
    for (const invokes of [true, false]) {
      for (let mask = 0; mask < 1 << UNIVERSE.length; mask++) {
        const permissions = UNIVERSE.filter((_, i) => mask & (1 << i));
        const held = new Set<string>(permissions);
        expect({
          invokes,
          permissions,
          ...agentCapabilities((p) => held.has(p), invokes),
        }).toEqual({ invokes, permissions, ...spec(held, invokes) });
      }
    }
  });

  it("puts `invokes` in every level: no dispatch, no run level and no authoring", () => {
    // A grant the caller cannot dispatch is a grant it cannot use. This case
    // holds every run/authoring permission and still reaches nothing.
    const held = new Set(["agents:run", "agents:write", "runs:read-all"]);
    expect(agentCapabilities((p) => held.has(p), false)).toEqual({
      runLevel: "none",
      authors: false,
    });
    // Control: dispatching, the same grants reach the top level.
    expect(agentCapabilities((p) => held.has(p), true)).toEqual({
      runLevel: "compose",
      authors: true,
    });
  });
});

describe("reaches", () => {
  const ORDER: readonly RunLevel[] = ["none", "read", "run", "compose"];

  it("is true exactly when the level is at or above the floor", () => {
    for (const [i, level] of ORDER.entries()) {
      for (const [j, floor] of ORDER.entries()) {
        expect({ level, floor, reaches: reaches(level, floor) }).toEqual({
          level,
          floor,
          reaches: i >= j,
        });
      }
    }
  });
});
