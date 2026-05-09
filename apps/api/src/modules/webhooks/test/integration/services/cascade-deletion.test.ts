// SPDX-License-Identifier: Apache-2.0

/**
 * Cascade deletion test for webhook-owned tables.
 *
 * Asserts that the module's `application_id` FK to `applications` is declared
 * with ON DELETE CASCADE. Lives in the module (not core) because the FK is
 * declared in the webhooks module migration, not in core schema.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import { seedApplication } from "../../../../../../test/helpers/seed.ts";
import { assertDbHas, assertDbMissing } from "../../../../../../test/helpers/assertions.ts";
import { deleteApplication } from "../../../../../services/applications.ts";
import { seedWebhook } from "../../helpers/seed.ts";
import { webhooks } from "../../../schema.ts";

describe("Webhooks cascade deletion", () => {
  let userId: string;
  let orgId: string;
  let applicationId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser();
    userId = id;
    const { org, defaultAppId } = await createTestOrg(userId);
    orgId = org.id;
    applicationId = defaultAppId;
  });

  it("deleting an application cascades to its webhooks", async () => {
    const customApp = await seedApplication({ orgId, name: "Cascade Target", createdBy: userId });
    const wh = await seedWebhook({ orgId, applicationId: customApp.id });

    await assertDbHas(webhooks, eq(webhooks.id, wh.id));

    await deleteApplication(orgId, customApp.id);

    await assertDbMissing(webhooks, eq(webhooks.id, wh.id));
  });

  it("deleting a custom app does not affect webhooks in the default app", async () => {
    const defaultWh = await seedWebhook({ orgId, applicationId: applicationId });

    const customApp = await seedApplication({ orgId, name: "Expendable", createdBy: userId });
    await seedWebhook({ orgId, applicationId: customApp.id });
    await deleteApplication(orgId, customApp.id);

    await assertDbHas(webhooks, eq(webhooks.id, defaultWh.id));
    expect(defaultWh.applicationId).toBe(applicationId);
  });
});
