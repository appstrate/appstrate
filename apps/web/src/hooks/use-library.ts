// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";

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
  appId: string,
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
                ? [...pkg.installedIn, appId]
                : pkg.installedIn.filter((id) => id !== appId),
          };
        }),
      ]),
    ),
  };
}

export function useTogglePackageInstall() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();

  return useMutation({
    mutationFn: async ({
      appId,
      packageId,
      installed,
    }: {
      appId: string;
      packageId: string;
      installed: boolean;
    }) => {
      if (installed) {
        return api(`/applications/${appId}/packages/${packageId}`, { method: "DELETE" });
      }
      return api(`/applications/${appId}/packages`, {
        method: "POST",
        body: JSON.stringify({ packageId }),
      });
    },
    onMutate: async ({ appId, packageId, installed }) => {
      const key = ["library", orgId];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LibraryResponse>(key);
      qc.setQueryData<LibraryResponse>(key, (old) =>
        updateLibraryCache(old, packageId, appId, installed ? "uninstall" : "install"),
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
