// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseScopedName } from "@appstrate/core/naming";
import { $api, client, type components, type paths } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { agentsKeys, packageKeys } from "../lib/query-keys";

/** Wire shape from the OpenAPI spec (GET /api/library response). */
type LibraryResponse =
  paths["/api/library"]["get"]["responses"][200]["content"]["application/json"];

export type LibraryPackageItem = components["schemas"]["LibraryPackageList"][number];

export type LibraryApp = LibraryResponse["applications"][number];

/**
 * Org context for the library query. The header is a spec-declared param
 * passed explicitly (instead of relying on the client middleware alone) so it
 * is part of the React Query key — switching org refetches instead of serving
 * another org's cached library.
 */
function useLibraryScope() {
  const orgId = useCurrentOrgId();
  return {
    enabled: !!orgId,
    init: { params: { header: { "X-Org-Id": orgId ?? undefined } } },
  };
}

export function useLibrary() {
  const scope = useLibraryScope();
  return $api.useQuery("get", "/api/library", scope.init, { enabled: scope.enabled });
}

function updateLibraryCache(
  prev: LibraryResponse | undefined,
  packageId: string,
  applicationId: string,
  action: "install" | "uninstall",
): LibraryResponse | undefined {
  if (!prev) return prev;
  const mapGroup = (pkgs: LibraryPackageItem[]) =>
    pkgs.map((pkg) => {
      if (pkg.id !== packageId) return pkg;
      return {
        ...pkg,
        installed_in:
          action === "install"
            ? [...pkg.installed_in, applicationId]
            : pkg.installed_in.filter((id) => id !== applicationId),
      };
    });
  return {
    ...prev,
    packages: {
      agent: mapGroup(prev.packages.agent),
      skill: mapGroup(prev.packages.skill),
      "mcp-server": mapGroup(prev.packages["mcp-server"]),
      integration: mapGroup(prev.packages.integration),
    },
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
            .filter((a) => libraryPkg.installed_in.includes(a.id))
            .map((a) => a.name)
        : [];

    const isInstalledInCurrentApp = !!(
      currentAppId && libraryPkg?.installed_in.includes(currentAppId)
    );

    return { installedAppNames, isInstalledInCurrentApp };
  }, [libraryData, packageId, currentAppId]);
}

export function useTogglePackageInstall() {
  const qc = useQueryClient();
  const scope = useLibraryScope();
  // Exact key of the useLibrary query (same init) for the optimistic update.
  const libraryKey = $api.queryOptions("get", "/api/library", scope.init).queryKey;

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
        // The uninstall route splits the `@scope/name` package id into two
        // path params — required so the typed client never percent-encodes
        // the `/` separating scope from name.
        const parsed = parseScopedName(packageId);
        if (!parsed) throw new Error(`Invalid packageId: ${packageId}`);
        await client.DELETE("/api/applications/{applicationId}/packages/{scope}/{name}", {
          params: {
            path: { applicationId, scope: `@${parsed.scope}`, name: parsed.name },
          },
        });
        return;
      }
      await client.POST("/api/applications/{applicationId}/packages", {
        params: { path: { applicationId } },
        body: { packageId },
      });
    },
    onMutate: async ({ applicationId, packageId, installed }) => {
      await qc.cancelQueries({ queryKey: libraryKey });
      const prev = qc.getQueryData<LibraryResponse>(libraryKey);
      qc.setQueryData<LibraryResponse>(libraryKey, (old) =>
        updateLibraryCache(old, packageId, applicationId, installed ? "uninstall" : "install"),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(libraryKey, ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/library"] });
      // Legacy keys — package/agent lists are still on the legacy cache.
      void qc.invalidateQueries({ queryKey: packageKeys.all });
      void qc.invalidateQueries({ queryKey: agentsKeys.all });
    },
  });
}
