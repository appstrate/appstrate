// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for #1347 (and the bug #1295 fixed by hand): `@better-auth/core`
 * must resolve to ONE copy for every consumer in `apps/api`'s import graph.
 *
 * `oauth2/verify.mjs` marks insufficient-scope errors in a module-level
 * WeakSet, so `createInsufficientScopeError` (minted through `better-auth`)
 * and `isInsufficientScopeError` (read by `@better-auth/oauth-provider` when
 * building the step-up challenge) are only the same marker while both come
 * from the same copy. #1295 was that invariant broken: `apps/api` pinned
 * `jose ^6.2.12` while better-auth's transitive `jose` sat at 6.2.7, so bun
 * materialised two peer instances of `@better-auth/core@1.7.3` and the MCP 403
 * silently lost its `WWW-Authenticate` header.
 *
 * The behavioural half is covered by
 * `src/modules/mcp/test/integration/mcp.test.ts` ("403s an authenticated
 * caller lacking `mcp:read` with an `insufficient_scope` step-up challenge").
 * What was unguarded — and is what this asserts — is the resolution itself,
 * which depends on the peer graph rather than on any line of our code: it can
 * split again on the next dependency bump, silently, with the code unchanged.
 * `jose` is pinned in the root `overrides` (next to `zod`, which is why zod
 * never split) so the peers cannot skew; this test is what notices if they do.
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
