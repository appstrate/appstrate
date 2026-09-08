// SPDX-License-Identifier: Apache-2.0

/**
 * The per-principal grant resolver: union, filtering, failure isolation,
 * caching and invalidation. Boot-time validation of `mayGrant` belongs to the
 * platform's module loader and is tested there.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  invalidatePrincipalPermissions,
  resolvePrincipalPermissions,
  setPrincipalPermissionsProviders,
  type RegisteredPrincipalPermissions,
} from "../src/principal-permissions.ts";

const PRINCIPAL = { orgId: "org_1", userId: "usr_1" };

function provider(
  moduleId: string,
  mayGrant: readonly string[],
  resolve: RegisteredPrincipalPermissions["resolve"],
): RegisteredPrincipalPermissions {
  return { moduleId, mayGrant, resolve };
}

afterEach(() => {
  setPrincipalPermissionsProviders(null);
});

describe("resolvePrincipalPermissions", () => {
  it("unions every module's answer", async () => {
    setPrincipalPermissionsProviders([
      provider("a", ["x:read"], async () => ["x:read"]),
      provider("b", ["y:read"], async () => ["y:read"]),
    ]);
    expect([...(await resolvePrincipalPermissions(PRINCIPAL))].sort()).toEqual([
      "x:read",
      "y:read",
    ]);
  });

  it("drops a string the module did not declare, keeping the ones it did", async () => {
    setPrincipalPermissionsProviders([
      provider("a", ["x:read"], async () => ["x:read", "z:delete"]),
    ]);
    const granted = await resolvePrincipalPermissions(PRINCIPAL);
    expect(granted.has("x:read")).toBe(true);
    expect(granted.has("z:delete")).toBe(false);
  });

  it("isolates a throwing resolver from the modules around it", async () => {
    setPrincipalPermissionsProviders([
      provider("boom", ["x:read"], async () => {
        throw new Error("down");
      }),
      provider("fine", ["y:read"], async () => ["y:read"]),
    ]);
    expect([...(await resolvePrincipalPermissions(PRINCIPAL))]).toEqual(["y:read"]);
  });

  it("resolves once per principal until invalidated", async () => {
    let calls = 0;
    let answer: string[] = ["x:read"];
    setPrincipalPermissionsProviders([
      provider("a", ["x:read"], async () => {
        calls++;
        return answer;
      }),
    ]);

    await resolvePrincipalPermissions(PRINCIPAL);
    await resolvePrincipalPermissions(PRINCIPAL);
    expect(calls).toBe(1);

    answer = [];
    expect((await resolvePrincipalPermissions(PRINCIPAL)).has("x:read")).toBe(true);

    invalidatePrincipalPermissions(PRINCIPAL.orgId, PRINCIPAL.userId);
    expect((await resolvePrincipalPermissions(PRINCIPAL)).has("x:read")).toBe(false);
    expect(calls).toBe(2);
  });

  it("invalidates the whole org when no user is named", async () => {
    let answer: string[] = ["x:read"];
    setPrincipalPermissionsProviders([provider("a", ["x:read"], async () => answer)]);
    const other = { orgId: "org_1", userId: "usr_2" };

    await resolvePrincipalPermissions(PRINCIPAL);
    await resolvePrincipalPermissions(other);
    answer = [];
    invalidatePrincipalPermissions(PRINCIPAL.orgId);

    expect((await resolvePrincipalPermissions(PRINCIPAL)).size).toBe(0);
    expect((await resolvePrincipalPermissions(other)).size).toBe(0);
  });

  it("does not touch the cache when no module declares the surface", async () => {
    setPrincipalPermissionsProviders([]);
    const one = await resolvePrincipalPermissions(PRINCIPAL);
    const another = await resolvePrincipalPermissions({ orgId: "org_9", userId: "usr_9" });

    // Discriminating on identity: a cached path stores one Set PER KEY, so two
    // different principals could not answer with the same object. The shared
    // empty set is the proof that neither `get` nor `set` ran.
    expect(one.size).toBe(0);
    expect(one).toBe(another);
  });
});
