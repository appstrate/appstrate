// SPDX-License-Identifier: Apache-2.0

import { pgEnum } from "drizzle-orm/pg-core";

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member", "viewer"]);

export const executionStatusEnum = pgEnum("execution_status", [
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

export const packageTypeEnum = pgEnum("package_type", ["flow", "skill", "tool", "provider"]);
export const packageSourceEnum = pgEnum("package_source", ["local", "system"]);
