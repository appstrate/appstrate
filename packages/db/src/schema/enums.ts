import { pgEnum } from "drizzle-orm/pg-core";

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member"]);

export const executionStatusEnum = pgEnum("execution_status", [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
]);

export const authModeEnum = pgEnum("auth_mode", [
  "oauth2",
  "oauth1",
  "api_key",
  "basic",
  "custom",
  "proxy",
]);

export const invitationStatusEnum = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "expired",
  "cancelled",
]);

export const packageTypeEnum = pgEnum("package_type", ["flow", "skill", "extension", "provider"]);
export const packageSourceEnum = pgEnum("package_source", ["built-in", "local", "system"]);
