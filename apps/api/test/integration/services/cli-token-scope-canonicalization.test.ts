// SPDX-License-Identifier: Apache-2.0

/**
 * `narrowScopeToClient` — legacy `documents:*` scopes must RESOLVE, not vanish
 * (issue #1177).
 *
 * The CLI token service intersects the scope string persisted on the
 * credential row with the `scopes` array declared on the `oauth_clients` row.
 * The #1177 rename split those two sides across two migrations and two deploy
 * moments: migration 0044 rewrote the client's `text[]` column, migration 0045
 * the credential's space-delimited `text` column. Between the code deploy and
 * 0045 — and for any row minted in that window, or an operator-set
 * `OIDC_INSTANCE_CLIENTS` still naming the old resource — the two sides
 * disagree.
 *
 * A raw string intersection would DROP the mismatched scope: no error, no
 * user-visible signal, just a `logger.warn` and a rotated JWT that quietly lost
 * file access. This test pins the defence: both sides are canonicalized before
 * intersecting, so a pre-rename refresh token still comes back with
 * `files:read`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { cliRefreshToken, oauthClient } from "@appstrate/db/schema";
import { rotateRefreshToken } from "../../../src/modules/oidc/services/cli-tokens.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";

const CLIENT_ID = "appstrate-cli-scope-canon";

/** Mirrors the service's private `hashRefreshToken`. */
function hashRefreshToken(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

async function seedClient(scopes: string[]): Promise<void> {
  await db.insert(oauthClient).values({
    id: crypto.randomUUID(),
    clientId: CLIENT_ID,
    redirectUris: ["http://127.0.0.1:1/callback"],
    scopes,
    level: "instance",
  });
}

/** Seed a usable family-head refresh token carrying `scope` verbatim. */
async function seedHeadToken(ctx: TestContext, scope: string): Promise<string> {
  const plain = `crf_${crypto.randomUUID()}`;
  await db.insert(cliRefreshToken).values({
    id: crypto.randomUUID(),
    tokenHash: hashRefreshToken(plain),
    userId: ctx.user.id,
    clientId: CLIENT_ID,
    familyId: crypto.randomUUID(),
    scope,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return plain;
}

describe("CLI refresh rotation — legacy documents:* scopes canonicalize", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "cli-scope-canon" });
  });

  it("yields files:read for a pre-#1177 row against a post-0044 client", async () => {
    // The exact production shape mid-deploy: client rewritten by 0044,
    // refresh token still holding the pre-rename spelling.
    await seedClient(["files:read", "runs:read"]);
    const refreshToken = await seedHeadToken(ctx, "documents:read runs:read");

    const pair = await rotateRefreshToken({ refreshToken, clientId: CLIENT_ID });

    expect(pair.scope.split(" ").sort()).toEqual(["files:read", "runs:read"]);
    expect(pair.scope).not.toContain("documents:");
  });

  it("resolves the mirror case — legacy client, already-canonical token", async () => {
    // An operator-set `OIDC_INSTANCE_CLIENTS` still naming the old resource.
    await seedClient(["documents:read", "runs:read"]);
    const refreshToken = await seedHeadToken(ctx, "files:read runs:read");

    const pair = await rotateRefreshToken({ refreshToken, clientId: CLIENT_ID });

    expect(pair.scope.split(" ").sort()).toEqual(["files:read", "runs:read"]);
  });

  it("still drops a scope the client genuinely does not declare", async () => {
    // The canonicalization must not weaken the narrowing itself: a scope
    // absent from the client's set is dropped exactly as before.
    await seedClient(["files:read"]);
    const refreshToken = await seedHeadToken(ctx, "documents:read agents:run");

    const pair = await rotateRefreshToken({ refreshToken, clientId: CLIENT_ID });

    expect(pair.scope).toBe("files:read");
  });

  it("persists the canonical scope onto the rotated child row", async () => {
    // The stored value must converge too — otherwise every rotation re-derives
    // the legacy spelling and the row never heals.
    await seedClient(["files:read", "runs:read"]);
    const refreshToken = await seedHeadToken(ctx, "documents:read runs:read");

    const pair = await rotateRefreshToken({ refreshToken, clientId: CLIENT_ID });

    const [child] = await db
      .select({ scope: cliRefreshToken.scope })
      .from(cliRefreshToken)
      .where(eq(cliRefreshToken.tokenHash, hashRefreshToken(pair.refreshToken)));
    expect(child!.scope).toBe("files:read runs:read");
  });
});
