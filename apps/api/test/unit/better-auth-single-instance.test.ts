// SPDX-License-Identifier: Apache-2.0

/**
 * `@better-auth/core` must resolve to ONE copy for every consumer in
 * `apps/api`'s import graph.
 *
 * `oauth2/verify.mjs` marks insufficient-scope errors in a module-level
 * WeakSet, so `createInsufficientScopeError` (minted through `better-auth`)
 * and `isInsufficientScopeError` (read by `@better-auth/oauth-provider` when
 * building the step-up challenge) are only the same marker while both come
 * from the same copy; a split silently drops the MCP 403's
 * `WWW-Authenticate` header — the behaviour covered in
 * `src/modules/mcp/test/integration/mcp.test.ts`.
 *
 * The resolution depends on the peer graph, not on any line of our code: a
 * skewed `jose` peer splits it with the code unchanged, which is why `jose`
 * sits in the root `overrides` beside `zod`. This test notices a split.
 */

import { describe, it, expect } from "bun:test";
import { dirname } from "node:path";

/** Where `specifier` resolves to when imported from `fromDir`. */
function resolveFrom(specifier: string, fromDir: string): string {
  return Bun.resolveSync(specifier, fromDir);
}

/** The directory a package's own imports resolve from. */
function packageDir(specifier: string, fromDir: string): string {
  return dirname(resolveFrom(specifier, fromDir));
}

describe("better-auth instance identity", () => {
  it("resolves one @better-auth/core for apps/api, better-auth and the oauth provider", () => {
    const api = import.meta.dir;
    const facade = packageDir("better-auth/oauth2", api);
    const provider = packageDir("@better-auth/oauth-provider", api);

    const fromApi = resolveFrom("@better-auth/core/oauth2", api);
    const fromFacade = resolveFrom("@better-auth/core/oauth2", facade);
    const fromProvider = resolveFrom("@better-auth/core/oauth2", provider);

    expect(fromFacade).toBe(fromApi);
    expect(fromProvider).toBe(fromApi);
  });

  it("resolves one better-auth, and one jose under it", () => {
    const api = import.meta.dir;
    const core = packageDir("@better-auth/core/oauth2", api);
    const provider = packageDir("@better-auth/oauth-provider", api);

    expect(resolveFrom("better-auth/oauth2", provider)).toBe(
      resolveFrom("better-auth/oauth2", api),
    );
    expect(resolveFrom("jose", core)).toBe(resolveFrom("jose", api));
  });
});
