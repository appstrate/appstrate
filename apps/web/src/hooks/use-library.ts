// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

export interface LibraryPackageItem {
  id: string;
  type: string;
  source: "system" | "local";
  name: string;
  description: string;
  installedIn: string[];
}

export interface LibraryApp {
  id: string;
  name: string;
  isDefault: boolean;
}

interface LibraryResponse {
  object: "library";
  applications: LibraryApp[];
  packages: Record<string, LibraryPackageItem[]>;
}

export function useLibrary() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["library", orgId],
    queryFn: () => api<LibraryResponse>("/library"),
    enabled: !!orgId,
  });
}

function updateLibraryCache(
  prev: LibraryResponse | undefined,
  packageId: string,
  applicationId: string,
  action: "install" | "uninstall",
): LibraryResponse | undefined {
  if (!prev) return prev;
  return {
    ...prev,
    packages: Object.fromEntries(
      Object.entries(prev.packages).map(([type, pkgs]) => [
        type,
        pkgs.map((pkg) => {
          if (pkg.id !== packageId) return pkg;
          return {
            ...pkg,
            installedIn:
              action === "install"
                ? [...pkg.installedIn, applicationId]
                : pkg.installedIn.filter((id) => id !== applicationId),
          };
        }),
      ]),
    ),
  };
}

/**
 * Derive install state for a single package from the library cache.
 * Returns which app names have it installed and whether the current app does.
 */
export function usePackageInstallState(packageId: string) {
  const { data: libraryData } = useLibrary();
  const currentAppId = useCurrentApplicationId();

  return useMemo(() => {
    const libraryPkg = libraryData
      ? Object.values(libraryData.packages)
          .flat()
          .find((p) => p.id === packageId)
      : undefined;

    const installedAppNames =
      libraryPkg && libraryData
        ? libraryData.applications
            .filter((a) => libraryPkg.installedIn.includes(a.id))
            .map((a) => a.name)
        : [];

    const isInstalledInCurrentApp = !!(
      currentAppId && libraryPkg?.installedIn.includes(currentAppId)
    );

    return { installedAppNames, isInstalledInCurrentApp };
  }, [libraryData, packageId, currentAppId]);
}

export function useTogglePackageInstall() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();

  return useMutation({
    mutationFn: async ({
      applicationId,
      packageId,
      installed,
    }: {
      applicationId: string;
      packageId: string;
      installed: boolean;
    }) => {
      if (installed) {
        return api(`/applications/${applicationId}/packages/${packageId}`, { method: "DELETE" });
      }
      return api(`/applications/${applicationId}/packages`, {
        method: "POST",
        body: JSON.stringify({ packageId }),
      });
    },
    onMutate: async ({ applicationId, packageId, installed }) => {
      const key = ["library", orgId];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LibraryResponse>(key);
      qc.setQueryData<LibraryResponse>(key, (old) =>
        updateLibraryCache(old, packageId, applicationId, installed ? "uninstall" : "install"),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["library", orgId], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["library"] });
      qc.invalidateQueries({ queryKey: ["packages"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
