// SPDX-License-Identifier: Apache-2.0

import type { InferSelectModel } from "drizzle-orm";
import type { profiles } from "./profiles.ts";
import type { packages, spacePackages } from "./packages.ts";
import type { runs, runLogs, schedules, packagePersistence } from "./runs.ts";
import type { spaces, endUsers } from "./spaces.ts";
import type { integrationConnections } from "./integrations.ts";
import type { integrationPins } from "./integration-pins.ts";
import type { user } from "./auth.ts";
import type { organizations, modelProviderCredentials, orgModels } from "./organizations.ts";

export type UserProfile = InferSelectModel<typeof profiles>;

export type Package = InferSelectModel<typeof packages>;

export type Schedule = InferSelectModel<typeof schedules>;

export type Run = InferSelectModel<typeof runs>;

export type RunLog = InferSelectModel<typeof runLogs>;

export type Space = InferSelectModel<typeof spaces>;

export type EndUser = InferSelectModel<typeof endUsers>;

export type SpacePackage = InferSelectModel<typeof spacePackages>;

export type Organization = InferSelectModel<typeof organizations>;

export type ModelProviderCredential = InferSelectModel<typeof modelProviderCredentials>;

export type OrgModel = InferSelectModel<typeof orgModels>;

export type User = InferSelectModel<typeof user>;

export type PackagePersistenceRow = InferSelectModel<typeof packagePersistence>;

export type IntegrationConnectionRow = InferSelectModel<typeof integrationConnections>;

export type IntegrationPinRow = InferSelectModel<typeof integrationPins>;
