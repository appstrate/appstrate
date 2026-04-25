// SPDX-License-Identifier: Apache-2.0

import { pgEnum } from "drizzle-orm/pg-core";

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member", "viewer"]);

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "expired",
  "cancelled",
]);

export const packageTypeEnum = pgEnum("package_type", ["agent", "skill", "tool", "provider"]);
export const packageSourceEnum = pgEnum("package_source", ["local", "system"]);

/**
 * Source discriminator for `llm_usage` rows. Each source has its own
 * dedup key: `proxy` rows dedup on `request_id`, `runner` rows dedup on
 * `(run_id, sequence)`.
 */
export const llmUsageSourceEnum = pgEnum("llm_usage_source", ["proxy", "runner"]);
