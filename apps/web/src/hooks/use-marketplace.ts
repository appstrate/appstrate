import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PackageType } from "@appstrate/shared-types";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

interface MarketplaceStatus {
  configured: boolean;
  registryUrl: string | null;
  connected: boolean;
  oauth?: { authorizationUrl: string; tokenUrl: string };
}

interface MarketplacePackage {
  id: number;
  scope: string;
  name: string;
  type: PackageType;
  description: string;
  keywords: string[];
  downloads: number;
  latestVersion: string | null;
  displayName: string | null;
  license: string | null;
  updatedAt: string;
}

interface MarketplaceSearchResult {
  packages: MarketplacePackage[];
  total: number;
  page: number;
  perPage: number;
}

interface MarketplacePackageDetail {
  id: number;
  scope: string;
  name: string;
  type: PackageType;
  displayName: string | null;
  description: string;
  keywords: string[];
  readme: string | null;
  repositoryUrl: string | null;
  license: string | null;
  versions: Array<{
    id: number;
    version: string;
    integrity: string;
    artifactSize: number;
    createdAt: string;
  }>;
  downloads: number;
  createdAt: string;
  updatedAt: string;
  installedVersion: string | null;
  integrityConflict: boolean;
  localVersionAhead: string | null;
  distTags?: Array<{ tag: string; versionId: number }>;
}

interface SearchOpts {
  q?: string;
  type?: string;
  sort?: string;
  page?: number;
  perPage?: number;
}

interface InstallResult {
  packageId: string;
  type: string;
  version: string | null;
  autoInstalledDeps?: { packageId: string; type: string; version: string | null }[];
}

export interface PackageUpdateStatus {
  id: string;
  type: PackageType;
  scope: string;
  name: string;
  displayName: string | null;
  installedVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}

export function useMarketplaceStatus() {
  return useQuery({
    queryKey: ["marketplace", "status"],
    queryFn: () => api<MarketplaceStatus>("/marketplace/status"),
    staleTime: 60_000,
  });
}

export function useMarketplaceSearch(opts: SearchOpts, enabled = true) {
  const orgId = useCurrentOrgId();
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.type) params.set("type", opts.type);
  if (opts.sort) params.set("sort", opts.sort);
  if (opts.page) params.set("page", String(opts.page));
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  const qs = params.toString();

  return useQuery({
    queryKey: ["marketplace", "search", orgId, qs],
    queryFn: () => api<MarketplaceSearchResult>(`/marketplace/search${qs ? `?${qs}` : ""}`),
    enabled,
  });
}

export function useMarketplacePackage(scope: string | undefined, name: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["marketplace", "package", orgId, scope, name],
    queryFn: () => api<MarketplacePackageDetail>(`/marketplace/packages/${scope}/${name}`),
    enabled: !!scope && !!name,
  });
}

export function useInstallPackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { scope: string; name: string; version?: string; force?: boolean }) =>
      api<InstallResult>("/marketplace/install", { method: "POST", body: JSON.stringify(opts) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketplace"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}

export function useMarketplaceUpdates() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["marketplace", "updates", orgId],
    queryFn: () => api<{ updates: PackageUpdateStatus[] }>("/marketplace/updates"),
    staleTime: 5 * 60_000,
  });
}

export function useUpdatePackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: { scope: string; name: string }) =>
      api<InstallResult>("/marketplace/update", { method: "POST", body: JSON.stringify(opts) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketplace"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      qc.invalidateQueries({ queryKey: ["flows"] });
      qc.invalidateQueries({ queryKey: ["providers"] });
    },
  });
}
