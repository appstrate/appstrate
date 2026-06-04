// SPDX-License-Identifier: Apache-2.0

/**
 * Identity guard on connection upgrade/reconnect: an `update-owned` write
 * (scope upgrade / reconnect) must stay on the SAME upstream account. If the
 * re-consent authenticated a different identity, `persistCredentialBundle`
 * refuses (409 identity_mismatch) and leaves the row untouched — silently
 * rebinding a connection to another account would be a data-integrity and
 * access surprise. "default" (identity-less) never blocks an upgrade.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { saveIntegrationConnection } from "../../../src/services/integration-connections.ts";
import { integrationConnections } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import type { AppScope } from "../../../src/lib/scope.ts";
import type { Actor } from "@appstrate/connect";

const INTEGRATION = "@orga/gmail";

describe("integration connection — identity guard on reconnect/upgrade", () => {
  let ctx: TestContext;
  let scope: AppScope;
  let actor: Actor;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "idguard" });
    scope = { orgId: ctx.orgId, applicationId: ctx.defaultAppId };
    actor = { type: "user", id: ctx.user.id };
    await seedPackage({ id: INTEGRATION, orgId: ctx.orgId, type: "integration", source: "local" });
  });

  function connect(accountId: string, connectionId?: string) {
    return saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "oauth",
      accountId,
      credentials: { access_token: "tok" },
      identityClaims: { email: accountId },
      actor,
      ...(connectionId ? { connectionId } : {}),
    });
  }

  it("allows a same-account reconnect (scope upgrade)", async () => {
    const created = await connect("alice@example.com");
    // Label is set at creation to the extracted identity (accountId).
    expect(created.label).toBe("alice@example.com");
    const updated = await connect("alice@example.com", created.id);
    expect(updated.id).toBe(created.id);
    expect(updated.account_id).toBe("alice@example.com");
    // Reconnect never rewrites the label.
    expect(updated.label).toBe("alice@example.com");
  });

  it("refuses a reconnect that authenticated a different account", async () => {
    const created = await connect("alice@example.com");
    await expect(connect("bob@example.com", created.id)).rejects.toThrow(/different account/i);

    // The row is untouched — still Alice.
    const after = await connect("alice@example.com", created.id);
    expect(after.account_id).toBe("alice@example.com");
  });

  it("reconnect with connectionId updates in place — no duplicate row; absent id inserts", async () => {
    // The single-writer contract the `connection_id` smuggle exists to satisfy
    // (integration-connections.ts:706, "explicit connectionId = update; no id =
    // insert"). The original bug: the reconnect CTA fired WITHOUT a connectionId,
    // so the OAuth callback INSERTed a second row instead of updating the
    // needs_reconnection one.
    const created = await connect("alice@example.com");
    const countAfterCreate = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(countAfterCreate.length).toBe(1);

    // Reconnect WITH the id (the fixed path): same row, still exactly one.
    const reconnected = await connect("alice@example.com", created.id);
    expect(reconnected.id).toBe(created.id);
    const countAfterReconnect = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(countAfterReconnect.length).toBe(1);

    // Connecting WITHOUT an id (the buggy path / a genuinely new connection)
    // INSERTs a second row — proving the divergence the smuggle guards against.
    const inserted = await connect("alice@example.com");
    expect(inserted.id).not.toBe(created.id);
    const countAfterInsert = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.integrationId, INTEGRATION));
    expect(countAfterInsert.length).toBe(2);
  });

  it("allows upgrading an identity-less connection to a real identity", async () => {
    // accountId "default" = no identity extracted (api_key/PAT-style).
    const created = await saveIntegrationConnection(scope, {
      packageId: INTEGRATION,
      authKey: "oauth",
      accountId: "default",
      credentials: { access_token: "tok" },
      actor,
    });
    // Identity-less connect falls back to the "Connexion N" label.
    expect(created.label).toBe("Connexion 1");
    const upgraded = await connect("alice@example.com", created.id);
    expect(upgraded.account_id).toBe("alice@example.com");
    // The label is fixed at creation — the upgrade doesn't rewrite it.
    expect(upgraded.label).toBe("Connexion 1");
  });
});
