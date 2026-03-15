// --- Module interface ---

export interface PackageTypeModule {
  detailToFormState: (detail: ContentPackageInput) => PackageFormState;
  defaultFormState: (orgSlug?: string, userEmail?: string) => PackageFormState;
  assemblePayload: (state: PackageFormState) => Record<string, unknown>;
}

/** Fields needed by module.detailToFormState() for skill/extension packages. */
export interface ContentPackageInput {
  id: string;
  displayName: string;
  description: string;
  source: string;
  version?: string | null;
  content?: string | null;
  manifest?: Record<string, unknown>;
  manifestName?: string | null;
  updatedAt?: string | null;
  lockVersion?: number;
}

// --- Generic form state ---

export interface PackageMetadata {
  id: string;
  scope: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  keywords: string[];
}

export interface PackageFormState {
  _type: "skill" | "extension";
  metadata: PackageMetadata;
  content: string;
  _manifestBase: Record<string, unknown>;
  _lockVersion?: number;
}

// --- Module registry ---

import { skillModule } from "./skill-module";
import { extensionModule } from "./extension-module";

const modules: Record<"skill" | "extension", PackageTypeModule> = {
  skill: skillModule,
  extension: extensionModule,
};

export function getPackageTypeModule(type: "skill" | "extension"): PackageTypeModule {
  return modules[type];
}
