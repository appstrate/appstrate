// --- Module interface ---

export interface PackageTypeModule {
  detailToFormState: (detail: ContentPackageInput) => PackageFormState;
  defaultFormState: (orgSlug?: string, userEmail?: string) => PackageFormState;
  assemblePayload: (state: PackageFormState) => Record<string, unknown>;
}

/** Fields needed by module.detailToFormState() for skill/tool packages. */
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
  _type: "skill" | "tool";
  metadata: PackageMetadata;
  content: string;
  _manifestBase: Record<string, unknown>;
  _lockVersion?: number;
}

// --- Module registry ---

import { skillModule } from "./skill-module";
import { toolModule } from "./tool-module";

const modules: Record<"skill" | "tool", PackageTypeModule> = {
  skill: skillModule,
  tool: toolModule,
};

export function getPackageTypeModule(type: "skill" | "tool"): PackageTypeModule {
  return modules[type];
}
