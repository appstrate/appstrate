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
import type { runs, runLogs, packageSchedules } from "./runs.ts";
import type { connectionProfiles, orgProfileProviderBindings } from "./connections.ts";
import type { applications, endUsers } from "./applications.ts";

export type Profile = InferSelectModel<typeof profiles>;

export type Package = InferSelectModel<typeof packages>;

export type PackageVersion = InferSelectModel<typeof packageVersions>;

export type PackageDistTag = InferSelectModel<typeof packageDistTags>;

export type PackageVersionDependency = InferSelectModel<typeof packageVersionDependencies>;

export type PackageSchedule = InferSelectModel<typeof packageSchedules>;

export type Run = InferSelectModel<typeof runs>;

export type RunLog = InferSelectModel<typeof runLogs>;

export type ConnectionProfile = InferSelectModel<typeof connectionProfiles>;

export type OrgProfileProviderBinding = InferSelectModel<typeof orgProfileProviderBindings>;

export type Application = InferSelectModel<typeof applications>;

export type EndUser = InferSelectModel<typeof endUsers>;

export type ApplicationPackage = InferSelectModel<typeof applicationPackages>;
