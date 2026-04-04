// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

export interface InstalledPackage {
  packageId: string;
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  orgProfileId: string | null;
  versionId: number | null;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  packageType: string;
  packageSource: string;
  draftManifest: Record<string, unknown> | null;
}

export function useInstalledPackages(type?: string) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  const params = type ? `?type=${type}` : "";
  return useQuery({
    queryKey: ["installed-packages", orgId, appId, type],
    queryFn: () =>
      api<{ object: "list"; data: InstalledPackage[] }>(
        `/applications/${appId}/packages${params}`,
      ).then((d) => d.data),
    enabled: !!orgId && !!appId,
  });
}

export function useInstallPackage() {
  const qc = useQueryClient();
  const appId = useCurrentApplicationId();
  return useMutation({
    mutationFn: async (data: { packageId: string; config?: Record<string, unknown> }) => {
      return api(`/applications/${appId}/packages`, {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installed-packages"] });
    },
  });
}

export function useUninstallPackage() {
  const qc = useQueryClient();
  const appId = useCurrentApplicationId();
  return useMutation({
    mutationFn: async (packageId: string) => {
      return api(`/applications/${appId}/packages/${packageId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["installed-packages"] });
    },
  });
}
