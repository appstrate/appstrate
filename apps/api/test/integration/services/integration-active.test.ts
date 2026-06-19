// SPDX-License-Identifier: Apache-2.0

/**
 * Integration activation precedence — the single source of truth consulted by
 * the spawn resolver, agent readiness, the sidecar credential/bundle guards,
 * and the UI list. One rule:
 *
 *   1. An `application_packages` row EXISTS → its `enabled` flag wins (the
 *      explicit, sticky operator decision; a disabled row stays inactive).
 *   2. NO row → auto-active iff the integration is a SYSTEM integration (offered
 *      via `SYSTEM_INTEGRATIONS`, with or WITHOUT a shared OAuth client — a DCR
 *      remote MCP ships no client yet is still auto-active). Else inactive.
 *
 * Covers `isIntegrationActive` (single) + `listActiveIntegrationIds` (batched),
 * including the sticky-disable path (system integration explicitly turned off
 * never silently re-activates).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { applicationPackages } from "@appstrate/db/schema";
import {
  isIntegrationActive,
  listActiveIntegrationIds,
} from "../../../src/services/integration-connections.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";

const SYSTEM_INTEGRATION = "@myorg/gmail";
const DCR_INTEGRATION = "@myorg/remote-mcp";
const PLAIN_INTEGRATION = "@myorg/clickup";

describe("integration activation precedence", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    // Listing gmail (with a shared client) and remote-mcp (NO client, DCR) makes
    // both SYSTEM integrations (auto-active). clickup is not listed.
    initSystemIntegrations([
      {
        id: SYSTEM_INTEGRATION,
        clients: [
          {
            id: "gmail-system",
            auth_key: "google",
            client_id: "sys-client.apps.googleusercontent.com",
            client_secret: "sys-secret",
          },
        ],
      },
      { id: DCR_INTEGRATION },
    ]);
    await seedPackage({ id: SYSTEM_INTEGRATION, orgId: ctx.orgId, type: "integration" });
    await seedPackage({ id: DCR_INTEGRATION, orgId: ctx.orgId, type: "integration" });
    await seedPackage({ id: PLAIN_INTEGRATION, orgId: ctx.orgId, type: "integration" });
  });

  afterEach(() => {
    __resetSystemIntegrationsForTest();
  });

  async function installRow(packageId: string, enabled: boolean) {
    await db
      .insert(applicationPackages)
      .values({ applicationId: ctx.defaultAppId, packageId, config: {}, enabled });
  }

  it("auto-activates a system integration with no install row", async () => {
    expect(await isIntegrationActive(SYSTEM_INTEGRATION, ctx.defaultAppId)).toBe(true);
  });

  it("auto-activates a DCR system integration that ships no client", async () => {
    // Membership in SYSTEM_INTEGRATIONS — not client presence — drives
    // auto-active, so a remote MCP relying on Dynamic Client Registration is on
    // by default even without a static client.
    expect(await isIntegrationActive(DCR_INTEGRATION, ctx.defaultAppId)).toBe(true);
  });

  it("respects an explicit disable on a DCR system integration (sticky opt-out)", async () => {
    await installRow(DCR_INTEGRATION, false);
    expect(await isIntegrationActive(DCR_INTEGRATION, ctx.defaultAppId)).toBe(false);
  });

  it("leaves a non-system integration inactive with no install row", async () => {
    expect(await isIntegrationActive(PLAIN_INTEGRATION, ctx.defaultAppId)).toBe(false);
  });

  it("respects an explicit disable on a system integration (sticky opt-out wins)", async () => {
    await installRow(SYSTEM_INTEGRATION, false);
    expect(await isIntegrationActive(SYSTEM_INTEGRATION, ctx.defaultAppId)).toBe(false);
  });

  it("honors an enabled install row for a non-system integration", async () => {
    await installRow(PLAIN_INTEGRATION, true);
    expect(await isIntegrationActive(PLAIN_INTEGRATION, ctx.defaultAppId)).toBe(true);
  });

  it("honors a disabled install row for a non-system integration", async () => {
    await installRow(PLAIN_INTEGRATION, false);
    expect(await isIntegrationActive(PLAIN_INTEGRATION, ctx.defaultAppId)).toBe(false);
  });

  it("batched listActiveIntegrationIds applies the same precedence", async () => {
    // system + no row → active; non-system + no row → inactive.
    const both = await listActiveIntegrationIds(
      [SYSTEM_INTEGRATION, PLAIN_INTEGRATION],
      ctx.defaultAppId,
    );
    expect(both.has(SYSTEM_INTEGRATION)).toBe(true);
    expect(both.has(PLAIN_INTEGRATION)).toBe(false);

    // Disable the system one, enable the plain one → flips both.
    await installRow(SYSTEM_INTEGRATION, false);
    await installRow(PLAIN_INTEGRATION, true);
    const flipped = await listActiveIntegrationIds(
      [SYSTEM_INTEGRATION, PLAIN_INTEGRATION],
      ctx.defaultAppId,
    );
    expect(flipped.has(SYSTEM_INTEGRATION)).toBe(false);
    expect(flipped.has(PLAIN_INTEGRATION)).toBe(true);
  });
});
