// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * The live model catalog an instance last accepted, byte for byte with its
 * detached signature (`docs/plans/live-model-catalog.md`). One row per Pi SDK
 * version; verified again on every load, so never a source of trust.
 */
export const modelCatalogOverlays = pgTable("model_catalog_overlays", {
  sdkVersion: text("sdk_version").primaryKey(),
  serial: bigint("serial", { mode: "number" }).notNull(),
  payload: text("payload").notNull(),
  signature: text("signature").notNull(),
  /** When the channel last served this file as its current one. */
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});
