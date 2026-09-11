// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseScopedName } from "@appstrate/core/naming";
import { $api, client, type components, type paths } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { agentsKeys, packageKeys } from "../lib/query-keys";
import { useOrgOnlyScope } from "./use-org-scope";

/** Wire shape from the OpenAPI spec (GET /api/library response). */
type LibraryResponse =
  paths["/api/library"]["get"]["responses"][200]["content"]["application/json"];

export type LibraryPackageItem = components["schemas"]["LibraryPackageList"][number];

export type LibrarySpace = LibraryResponse["spaces"][number];

export function useLibrary() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/library",
    { params: { header: scope.header } },
    { enabled: scope.enabled },
  );
}

function updateLibraryCache(
  prev: LibraryResponse | undefined,
  packageId: string,
  spaceId: string,
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
            ? [...pkg.installed_in, spaceId]
            : pkg.installed_in.filter((id) => id !== spaceId),
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
 * Returns which space names have it installed and whether the current space does.
 */
export function usePackageInstallState(packageId: string) {
  const { data: libraryData } = useLibrary();
  const currentSpaceId = useCurrentSpaceId();

  return useMemo(() => {
    const libraryPkg = libraryData
      ? Object.values(libraryData.packages)
          .flat()
          .find((p) => p.id === packageId)
      : undefined;

    const installedSpaceNames =
      libraryPkg && libraryData
        ? libraryData.spaces
            .filter((a) => libraryPkg.installed_in.includes(a.id))
            .map((a) => a.name)
        : [];

    const isInstalledInCurrentSpace = !!(
      currentSpaceId && libraryPkg?.installed_in.includes(currentSpaceId)
    );

    return { installedSpaceNames, isInstalledInCurrentSpace };
  }, [libraryData, packageId, currentSpaceId]);
}

export function useTogglePackageInstall() {
  const qc = useQueryClient();
  const scope = useOrgOnlyScope();
  // Exact key of the useLibrary query (same init) for the optimistic update.
  const libraryKey = $api.queryOptions("get", "/api/library", {
    params: { header: scope.header },
  }).queryKey;

  return useMutation({
    mutationFn: async ({
      spaceId,
      packageId,
      installed,
    }: {
      spaceId: string;
      packageId: string;
      installed: boolean;
    }) => {
      if (installed) {
        // The uninstall route splits the `@scope/name` package id into two
        // path params — required so the typed client never percent-encodes
        // the `/` separating scope from name.
        const parsed = parseScopedName(packageId);
        if (!parsed) throw new Error(`Invalid packageId: ${packageId}`);
        await client.DELETE("/api/spaces/{spaceId}/packages/{scope}/{name}", {
          params: {
            path: { spaceId, scope: `@${parsed.scope}`, name: parsed.name },
          },
        });
        return;
      }
      await client.POST("/api/spaces/{spaceId}/packages", {
        params: { path: { spaceId } },
        body: { packageId },
      });
    },
    onMutate: async ({ spaceId, packageId, installed }) => {
      await qc.cancelQueries({ queryKey: libraryKey });
      const prev = qc.getQueryData<LibraryResponse>(libraryKey);
      qc.setQueryData<LibraryResponse>(libraryKey, (old) =>
        updateLibraryCache(old, packageId, spaceId, installed ? "uninstall" : "install"),
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
