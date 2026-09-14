// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseScopedName } from "@appstrate/core/naming";
import { $api, client, type components, type paths } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { agentsKeys, packageKeys } from "../lib/query-keys";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useOrgOnlyScope } from "./use-org-scope";

/**
 * Wire shape from the OpenAPI spec (GET /api/library response) — the
 * organization catalog: which packages exist and where each one is active.
 */
export type LibraryResponse =
  paths["/api/library"]["get"]["responses"][200]["content"]["application/json"];

/**
 * The same matrix read from one space, plus the section only a space has:
 * `shared`, the offers still waiting on a decision. An offer is addressed to
 * a space, so it is read there — the organization catalog carries none.
 */
type SpaceLibraryResponse =
  paths["/api/spaces/{spaceId}/library"]["get"]["responses"][200]["content"]["application/json"];

export type LibraryPackageItem = components["schemas"]["LibraryPackageList"][number];

export type LibrarySpace = LibraryResponse["spaces"][number];

/** One package offered to a space and not yet installed there. */
export type LibraryOffer = SpaceLibraryResponse["shared"][number];

export function useLibrary() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/library",
    { params: { header: scope.header } },
    { enabled: scope.enabled },
  );
}

/** Space readers never need access to the organization administration view. */
export function useSpaceLibrary() {
  const scope = useOrgOnlyScope();
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/spaces/{spaceId}/library",
    { params: { path: { spaceId: spaceId ?? "" }, header: scope.header } },
    { enabled: scope.enabled && !!spaceId, staleTime: 0, refetchOnWindowFocus: true },
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
 * Derive whether a package is installed in the current space.
 *
 * The package's HOME is deliberately NOT derived here. It comes from the
 * package's own detail response (`home_space_id`), which every page showing it
 * already fetches — a cache built for install state is not the authority on who
 * may write the package, and reading it from two places invites the two to
 * disagree.
 */
export function usePackageInstallState(packageId: string) {
  const { data: libraryData } = useSpaceLibrary();
  const currentSpaceId = useCurrentSpaceId();

  return useMemo(() => {
    const libraryPkg = libraryData
      ? Object.values(libraryData.packages)
          .flat()
          .find((p) => p.id === packageId)
      : undefined;

    const isInstalledInCurrentSpace = !!(
      currentSpaceId && libraryPkg?.installed_in.includes(currentSpaceId)
    );

    return { isInstalledInCurrentSpace };
  }, [libraryData, packageId, currentSpaceId]);
}

/** Installation changes affect the library and every space's package/agent cache. */
export function useInvalidatePackageInstallation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/library"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{spaceId}/library"] });
    void qc.invalidateQueries({ queryKey: packageKeys.all });
    void qc.invalidateQueries({ queryKey: agentsKeys.all });
    void invalidateIntegrationQueries(qc);
  };
}

export function useTogglePackageInstall() {
  const qc = useQueryClient();
  const invalidate = useInvalidatePackageInstallation();
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
    onSettled: invalidate,
  });
}
