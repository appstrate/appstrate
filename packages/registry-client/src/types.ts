import type { Manifest } from "@appstrate/core/validation";

export interface RegistryConfig {
  baseUrl: string;
  accessToken?: string;
  /** Request timeout in ms. Default: 30_000 (120_000 for downloads). */
  timeout?: number;
  /** Max retries on network/5xx errors. Default: 2. */
  maxRetries?: number;
  /** Optional logger for request debugging. */
  logger?: { debug: (msg: string, data?: Record<string, unknown>) => void };
}

export interface RegistryDiscovery {
  registryVersion: string;
  apiBase: string;
  capabilities: string[];
  packageTypes: string[];
  oauth?: {
    authorizationUrl: string;
    tokenUrl: string;
  };
}

export interface RegistryPackageSummary {
  id: number;
  scope: string;
  name: string;
  type: "flow" | "skill" | "extension";
  description: string;
  keywords: string[];
  downloads: number;
  latestVersion: string | null;
  license: string | null;
  updatedAt: string;
}

export interface RegistrySearchResult {
  packages: RegistryPackageSummary[];
  total: number;
  page: number;
  perPage: number;
}

export interface RegistryVersionDetail {
  id: number;
  packageId: number;
  version: string;
  integrity: string;
  artifactPath: string;
  artifactSize: number;
  manifest: Manifest;
  yanked: boolean;
  yankedReason: string | null;
  publishedBy: string;
  createdAt: string;
}

export interface RegistryDependency {
  depScope: string;
  depName: string;
  depType: "flow" | "skill" | "extension";
  versionRange: string;
}

export interface RegistryPackageDetail {
  id: number;
  scope: string;
  name: string;
  type: "flow" | "skill" | "extension";
  description: string;
  keywords: string[];
  readme: string | null;
  repositoryUrl: string | null;
  license: string | null;
  createdBy: string;
  versions: RegistryVersionDetail[];
  distTags: Array<{
    packageId: number;
    tag: string;
    versionId: number;
    updatedAt: string;
  }>;
  downloads: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegistrySearchOptions {
  q?: string;
  type?: "flow" | "skill" | "extension" | "provider";
  sort?: "relevance" | "downloads" | "recent";
  page?: number;
  perPage?: number;
}

export interface RegistryAccount {
  id: string;
  username: string;
  email: string;
}

export interface RegistryScope {
  name: string;
  ownerId: string;
}

export interface PublishResult {
  scope: string;
  name: string;
  version: string;
  integrity: string;
  size: number;
  type: string;
}
