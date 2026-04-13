// SPDX-License-Identifier: Apache-2.0

/**
 * Webhooks module test seed helpers.
 *
 * Inserts real records into the webhooks-owned tables. Kept here (not in the
 * core seed helper) so that core tests running alone have zero dependency on
 * module-owned schemas.
 */
import { db } from "../../../../../test/helpers/db.ts";
import { webhooks } from "../../schema.ts";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

type WebhookInsert = Partial<InferInsertModel<typeof webhooks>> & {
  orgId: string;
  applicationId?: string | null;
};

export async function seedWebhook(
  overrides: WebhookInsert,
): Promise<InferSelectModel<typeof webhooks>> {
  const level: "org" | "application" =
    overrides.level === "org" || overrides.level === "application"
      ? overrides.level
      : overrides.applicationId
        ? "application"
        : "org";
  const values: InferInsertModel<typeof webhooks> = {
    id: `wh_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    level,
    orgId: overrides.orgId,
    applicationId: overrides.applicationId ?? null,
    url: overrides.url ?? "https://example.com/webhook",
    events: overrides.events ?? ["run.success"],
    secret: overrides.secret ?? crypto.randomUUID(),
    packageId: overrides.packageId ?? null,
    payloadMode: overrides.payloadMode ?? "full",
    enabled: overrides.enabled ?? true,
  };
  const [wh] = await db.insert(webhooks).values(values).returning();
  return wh!;
}
