// SPDX-License-Identifier: Apache-2.0

/**
 * Cascade deletion test for webhook-owned tables.
 *
 * Asserts that the module's `space_id` FK to `spaces` is declared
 * with ON DELETE CASCADE. Lives in the module (not core) because the FK is
 * declared in the webhooks module migration, not in core schema.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestUser, createTestOrg } from "../../../../../../test/helpers/auth.ts";
import { seedSpace } from "../../../../../../test/helpers/seed.ts";
import { assertDbHas, assertDbMissing } from "../../../../../../test/helpers/assertions.ts";
import { deleteSpace } from "../../../../../services/spaces.ts";
import { seedWebhook } from "../../helpers/seed.ts";
import { webhooks } from "@appstrate/db/schema";

describe("Webhooks cascade deletion", () => {
  let userId: string;
  let orgId: string;
  let spaceId: string;

  beforeEach(async () => {
    await truncateAll();
    const { id } = await createTestUser();
    userId = id;
    const { org, defaultSpaceId } = await createTestOrg(userId);
    orgId = org.id;
    spaceId = defaultSpaceId;
  });

  it("deleting a space cascades to its webhooks", async () => {
    const customSpace = await seedSpace({ orgId, name: "Cascade Target", createdBy: userId });
    const wh = await seedWebhook({ orgId, spaceId: customSpace.id });

    await assertDbHas(webhooks, eq(webhooks.id, wh.id));

    await deleteSpace(orgId, customSpace.id);

    await assertDbMissing(webhooks, eq(webhooks.id, wh.id));
  });

  it("deleting a custom app does not affect webhooks in the default app", async () => {
    const defaultWh = await seedWebhook({ orgId, spaceId: spaceId });

    const customSpace = await seedSpace({ orgId, name: "Expendable", createdBy: userId });
    await seedWebhook({ orgId, spaceId: customSpace.id });
    await deleteSpace(orgId, customSpace.id);

    await assertDbHas(webhooks, eq(webhooks.id, defaultWh.id));
    expect(defaultWh.spaceId).toBe(spaceId);
  });
});
