// SPDX-License-Identifier: Apache-2.0

import type { InferSelectModel } from "drizzle-orm";
import type { profiles } from "./profiles.ts";
import type { packages, packageVersions, applicationPackages } from "./packages.ts";
import type { runs, runLogs, schedules, packagePersistence } from "./runs.ts";
import type { applications, endUsers } from "./applications.ts";
import type { integrationConnections } from "./integrations.ts";
import type {
  browserConnectionAttempts,
  browserConnectionBindings,
  browserProfileDeletions,
  browserSessionLeases,
} from "./browser-connections.ts";
import type { integrationPins } from "./integration-pins.ts";
import type { user } from "./auth.ts";
import type { organizations, modelProviderCredentials, orgModels } from "./organizations.ts";

export type UserProfile = InferSelectModel<typeof profiles>;

export type Package = InferSelectModel<typeof packages>;

export type PackageVersion = InferSelectModel<typeof packageVersions>;

export type Schedule = InferSelectModel<typeof schedules>;

export type Run = InferSelectModel<typeof runs>;

export type RunLog = InferSelectModel<typeof runLogs>;

export type Application = InferSelectModel<typeof applications>;

export type EndUser = InferSelectModel<typeof endUsers>;

export type ApplicationPackage = InferSelectModel<typeof applicationPackages>;

export type Organization = InferSelectModel<typeof organizations>;

export type ModelProviderCredential = InferSelectModel<typeof modelProviderCredentials>;

export type OrgModel = InferSelectModel<typeof orgModels>;

export type User = InferSelectModel<typeof user>;

export type PackagePersistenceRow = InferSelectModel<typeof packagePersistence>;

export type IntegrationConnectionRow = InferSelectModel<typeof integrationConnections>;
export type BrowserConnectionBindingRow = InferSelectModel<typeof browserConnectionBindings>;
export type BrowserConnectionAttemptRow = InferSelectModel<typeof browserConnectionAttempts>;
export type BrowserSessionLeaseRow = InferSelectModel<typeof browserSessionLeases>;
export type BrowserProfileDeletionRow = InferSelectModel<typeof browserProfileDeletions>;

export type IntegrationPinRow = InferSelectModel<typeof integrationPins>;
