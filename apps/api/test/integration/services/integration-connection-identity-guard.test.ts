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
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { saveIntegrationConnection } from "../../../src/services/integration-connections.ts";
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
    expect(updated.accountId).toBe("alice@example.com");
    // Reconnect never rewrites the label.
    expect(updated.label).toBe("alice@example.com");
  });

  it("refuses a reconnect that authenticated a different account", async () => {
    const created = await connect("alice@example.com");
    await expect(connect("bob@example.com", created.id)).rejects.toThrow(/different account/i);

    // The row is untouched — still Alice.
    const after = await connect("alice@example.com", created.id);
    expect(after.accountId).toBe("alice@example.com");
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
    expect(upgraded.accountId).toBe("alice@example.com");
    // The label is fixed at creation — the upgrade doesn't rewrite it.
    expect(upgraded.label).toBe("Connexion 1");
  });
});
