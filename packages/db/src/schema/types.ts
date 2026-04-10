// SPDX-License-Identifier: Apache-2.0

import type { InferSelectModel } from "drizzle-orm";
import type { profiles } from "./profiles.ts";
import type {
  packages,
  packageVersions,
  packageDistTags,
  packageVersionDependencies,
  applicationPackages,
} from "./packages.ts";
import type { runs, runLogs, packageMemories } from "./runs.ts";
import type { packageSchedules } from "./schedules.ts";
import type {
  connectionProfiles,
  appProfileProviderBindings,
  userProviderConnections,
  applicationProviderCredentials,
  oauthStates,
  userAgentProviderProfiles,
} from "./connections.ts";
import type { applications, endUsers } from "./applications.ts";
import type { user, session, account, verification } from "./auth.ts";
import type {
  organizations,
  organizationMembers,
  apiKeys,
  orgInvitations,
  orgProxies,
} from "./organizations.ts";

export type Profile = InferSelectModel<typeof profiles>;

export type Package = InferSelectModel<typeof packages>;

export type PackageVersion = InferSelectModel<typeof packageVersions>;

export type PackageDistTag = InferSelectModel<typeof packageDistTags>;

export type PackageVersionDependency = InferSelectModel<typeof packageVersionDependencies>;

export type Run = InferSelectModel<typeof runs>;

export type RunLog = InferSelectModel<typeof runLogs>;

export type PackageSchedule = InferSelectModel<typeof packageSchedules>;

export type ConnectionProfile = InferSelectModel<typeof connectionProfiles>;

export type AppProfileProviderBinding = InferSelectModel<typeof appProfileProviderBindings>;

export type Application = InferSelectModel<typeof applications>;

export type EndUser = InferSelectModel<typeof endUsers>;

export type ApplicationPackage = InferSelectModel<typeof applicationPackages>;

export type UserProviderConnection = InferSelectModel<typeof userProviderConnections>;

export type ApplicationProviderCredential = InferSelectModel<typeof applicationProviderCredentials>;

export type OAuthState = InferSelectModel<typeof oauthStates>;

export type Organization = InferSelectModel<typeof organizations>;

export type OrganizationMember = InferSelectModel<typeof organizationMembers>;

export type ApiKey = InferSelectModel<typeof apiKeys>;

export type OrgInvitation = InferSelectModel<typeof orgInvitations>;

export type OrgProxy = InferSelectModel<typeof orgProxies>;

export type PackageMemory = InferSelectModel<typeof packageMemories>;

export type User = InferSelectModel<typeof user>;

export type Session = InferSelectModel<typeof session>;

export type Account = InferSelectModel<typeof account>;

export type Verification = InferSelectModel<typeof verification>;

export type UserAgentProviderProfile = InferSelectModel<typeof userAgentProviderProfiles>;
