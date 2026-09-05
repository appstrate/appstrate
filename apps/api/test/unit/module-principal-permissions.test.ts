// SPDX-License-Identifier: Apache-2.0

/**
 * Boot validation of `AppstrateModule.principalPermissions` (RBAC spec §4.2).
 *
 * `collectPrincipalPermissions` is the only place a `mayGrant` list is
 * reviewed, and everything downstream trusts it: the resolver filters against
 * the list without re-checking what is in it. So each refusal is asserted
 * against a legal neighbour that must still pass, or the test would also pass
 * on a validator that refuses everything.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  collectModulePermissions,
  collectPrincipalPermissions,
} from "../../src/lib/modules/module-loader.ts";
import { setModulePermissionsProvider } from "@appstrate/core/permissions";
import type { AppstrateModule } from "@appstrate/core/module";

function moduleGranting(mayGrant: readonly string[]): AppstrateModule {
  return {
    manifest: { id: "grantor", name: "Grantor", version: "1.0.0" },
    async init() {},
    principalPermissions: { mayGrant, resolve: async () => [] },
  };
}

/** Register the module RBAC snapshot the validator reads, as boot does. */
function withSnapshot(modules: readonly AppstrateModule[]): void {
  const snapshot = collectModulePermissions(modules);
  setModulePermissionsProvider(() => snapshot);
}

afterEach(() => {
  setModulePermissionsProvider(null);
});

describe("collectPrincipalPermissions — boot validation", () => {
  it("accepts a session-only core org-level permission", () => {
    const registered = collectPrincipalPermissions([moduleGranting(["org:delete"])]);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.moduleId).toBe("grantor");
    expect(registered[0]!.mayGrant).toEqual(["org:delete"]);
  });

  it("refuses a space-level permission", () => {
    expect(() => collectPrincipalPermissions([moduleGranting(["agents:read"])])).toThrow(
      /agents:read.*not a known org-level permission/s,
    );
  });

  it("refuses an unknown permission string", () => {
    expect(() => collectPrincipalPermissions([moduleGranting(["nope:read"])])).toThrow(
      /nope:read.*not a known org-level permission/s,
    );
  });

  it("refuses an org-level permission an API key may carry", () => {
    // `models:read` is org-level and legal everywhere else — the only thing
    // wrong with it here is that it sits in `API_KEY_ALLOWED_SCOPES`.
    expect(() => collectPrincipalPermissions([moduleGranting(["models:read"])])).toThrow(
      /models:read.*grantable to an API key/s,
    );
  });

  it("refuses an empty mayGrant list", () => {
    expect(() => collectPrincipalPermissions([moduleGranting([])])).toThrow(/empty mayGrant/);
  });

  it("accepts a module's own org-level contribution, and still refuses its API-key half", () => {
    const contributor = (mayGrant: readonly string[]): AppstrateModule => ({
      manifest: { id: "grantor", name: "Grantor", version: "1.0.0" },
      async init() {},
      permissionsContribution: () => [
        { resource: "cli-sessions", actions: ["read"], level: "org", grantTo: ["owner"] },
        // Org-level too, but opted into API keys — the neighbour that must fail.
        {
          resource: "oauth-clients",
          actions: ["read"],
          level: "org",
          grantTo: ["owner"],
          apiKeyGrantable: true,
        },
      ],
      principalPermissions: { mayGrant, resolve: async () => [] },
    });

    const ok = contributor(["cli-sessions:read"]);
    withSnapshot([ok]);
    expect(collectPrincipalPermissions([ok])[0]!.mayGrant).toEqual(["cli-sessions:read"]);

    const bad = contributor(["oauth-clients:read"]);
    withSnapshot([bad]);
    expect(() => collectPrincipalPermissions([bad])).toThrow(/grantable to an API key/);
  });

  it("registers nothing when no module declares the surface", () => {
    const plain: AppstrateModule = {
      manifest: { id: "plain", name: "Plain", version: "1.0.0" },
      async init() {},
    };
    expect(collectPrincipalPermissions([plain])).toEqual([]);
  });
});
