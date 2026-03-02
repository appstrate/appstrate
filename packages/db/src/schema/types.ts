import type { InferSelectModel } from "drizzle-orm";
import type { profiles } from "./profiles.ts";
import type { packages } from "./packages.ts";
import type { executions, executionLogs, packageSchedules } from "./executions.ts";
import type { connectionProfiles, providerConfigs } from "./connections.ts";

export type Profile = InferSelectModel<typeof profiles>;

export type Package = InferSelectModel<typeof packages>;

export type PackageSchedule = InferSelectModel<typeof packageSchedules>;

export type Execution = InferSelectModel<typeof executions>;

export type ExecutionLog = InferSelectModel<typeof executionLogs>;

export type ConnectionProfile = InferSelectModel<typeof connectionProfiles>;

export type ProviderConfig = InferSelectModel<typeof providerConfigs>;
