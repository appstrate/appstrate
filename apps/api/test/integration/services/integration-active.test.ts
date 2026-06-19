// SPDX-License-Identifier: Apache-2.0

/**
 * Integration activation precedence — the single source of truth consulted by
 * the spawn resolver, agent readiness, the sidecar credential/bundle guards,
 * and the UI list. One rule:
 *
 *   1. An `application_packages` row EXISTS → its `enabled` flag wins (the
 *      explicit, sticky operator decision; a disabled row stays inactive).
 *   2. NO row → auto-active iff the integration is a SYSTEM integration (ships
 *      a `SYSTEM_INTEGRATION_CLIENTS` client). Everything else is inactive.
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
  initSystemIntegrationClients,
  __resetSystemIntegrationClientsForTest,
} from "../../../src/services/integration-client-registry.ts";

const SYSTEM_INTEGRATION = "@myorg/gmail";
const PLAIN_INTEGRATION = "@myorg/clickup";

describe("integration activation precedence", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
    // A system client for the gmail integration makes it a SYSTEM integration
    // (auto-active). clickup has none.
    initSystemIntegrationClients([
      {
        id: "gmail-system",
        integrationId: SYSTEM_INTEGRATION,
        authKey: "google",
        clientId: "sys-client.apps.googleusercontent.com",
        clientSecret: "sys-secret",
      },
    ]);
    await seedPackage({ id: SYSTEM_INTEGRATION, orgId: ctx.orgId, type: "integration" });
    await seedPackage({ id: PLAIN_INTEGRATION, orgId: ctx.orgId, type: "integration" });
  });

  afterEach(() => {
    __resetSystemIntegrationClientsForTest();
  });

  async function installRow(packageId: string, enabled: boolean) {
    await db
      .insert(applicationPackages)
      .values({ applicationId: ctx.defaultAppId, packageId, config: {}, enabled });
  }

  it("auto-activates a system integration with no install row", async () => {
    expect(await isIntegrationActive(SYSTEM_INTEGRATION, ctx.defaultAppId)).toBe(true);
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
