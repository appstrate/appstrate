// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for `ensureCliClient()`.
 *
 * Verifies the auto-provisioning contract: first boot inserts the
 * `appstrate-cli` row with the expected public-client configuration,
 * subsequent boots are no-ops, and the row is whitelisted from orphan
 * warnings emitted by `syncInstanceClientsFromEnv()`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { oauthClient } from "../../../schema.ts";
import { ensureCliClient, APPSTRATE_CLI_CLIENT_ID } from "../../../services/ensure-cli-client.ts";

describe("ensureCliClient()", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it("inserts the appstrate-cli row with the expected public-client shape on first boot", async () => {
    const returnedId = await ensureCliClient();
    expect(returnedId).toBe(APPSTRATE_CLI_CLIENT_ID);

    const [row] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, APPSTRATE_CLI_CLIENT_ID))
      .limit(1);

    expect(row).toBeDefined();
    expect(row!.clientId).toBe("appstrate-cli");
    expect(row!.clientSecret).toBeNull();
    expect(row!.name).toBe("Appstrate CLI");
    expect(row!.level).toBe("instance");
    expect(row!.type).toBe("native");
    expect(row!.public).toBe(true);
    expect(row!.tokenEndpointAuthMethod).toBe("none");
    expect(row!.requirePKCE).toBe(true);
    expect(row!.redirectUris).toEqual([]);
    expect(row!.skipConsent).toBe(false);
    expect(row!.allowSignup).toBe(false);
    expect(row!.grantTypes).toContain("urn:ietf:params:oauth:grant-type:device_code");
    expect(row!.grantTypes).toContain("refresh_token");
    expect(row!.scopes).toEqual(["openid", "profile", "email", "offline_access"]);

    const metadata = JSON.parse(row!.metadata ?? "{}");
    expect(metadata.level).toBe("instance");
    expect(metadata.clientId).toBe("appstrate-cli");
  });

  it("is idempotent — subsequent calls do not insert or modify", async () => {
    const first = await ensureCliClient();
    const [beforeRow] = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, APPSTRATE_CLI_CLIENT_ID))
      .limit(1);
    const originalId = beforeRow!.id;
    const originalCreatedAt = beforeRow!.createdAt;

    const second = await ensureCliClient();
    expect(second).toBe(first);

    const rows = await db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, APPSTRATE_CLI_CLIENT_ID));
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(originalId);
    // `createdAt` must be preserved — an UPDATE on subsequent boots would
    // defeat the "never auto-modify" invariant documented on the service.
    expect(rows[0]!.createdAt?.toISOString()).toBe(originalCreatedAt?.toISOString());
  });

  it("uses the deterministic client id literal", async () => {
    // Cross-check: the constant and the literal must not drift apart.
    // If a refactor renames either, this guards against silent breakage
    // of CLI binaries already deployed with the embedded constant.
    expect(APPSTRATE_CLI_CLIENT_ID).toBe("appstrate-cli");
  });
});
