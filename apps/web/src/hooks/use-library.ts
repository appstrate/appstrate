// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "../i18n";
import { parseScopedName } from "@appstrate/core/naming";
import { $api, client, type paths } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { agentsKeys, invalidatePaths, packageKeys } from "../lib/query-keys";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useOrgOnlyScope } from "./use-org-scope";
import { activationGate, mayRemoveFromSpace } from "../lib/catalogue-gates";

/** `GET /api/library`: every package and where it is PLACED. The space form (`/api/spaces/{id}/library`) is the same shape narrowed to one space. */
export type LibraryResponse =
  paths["/api/library"]["get"]["responses"][200]["content"]["application/json"];

export type LibraryPackageItem = LibraryResponse["packages"]["agent"][number];

export type LibrarySpace = LibraryResponse["spaces"][number];

/** Where one package sits in one space: how it got there (`via`) and whether it runs (`state`); `"none"` is no row here (the deployment default is off). */
export type LibraryPlacement = LibraryPackageItem["placements"][number];

/** `GET /api/library`, graded by the server (an admin's whole map, else the union of the caller's spaces); `enabled: false` reads nothing. */
export function useCatalogueLibrary({ enabled = true }: { enabled?: boolean } = {}) {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/library",
    { params: { header: scope.header } },
    { enabled: scope.enabled && enabled },
  );
}

/** One space's own library page; `enabled: false` is for a caller already holding the answer (e.g. a package detail), and still reads a cached snapshot. */
function useSpaceLibrary(options: { enabled?: boolean } = {}) {
  const scope = useOrgOnlyScope();
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/spaces/{spaceId}/library",
    { params: { path: { spaceId: spaceId ?? "" }, header: scope.header } },
    {
      enabled: scope.enabled && !!spaceId && (options.enabled ?? true),
      staleTime: 0,
      refetchOnWindowFocus: true,
    },
  );
}

/** The placement of `pkg` in `spaceId`, or `undefined` when it sits elsewhere. */
function placementIn(
  pkg: Pick<LibraryPackageItem, "placements">,
  spaceId: string | null | undefined,
): LibraryPlacement | undefined {
  if (!spaceId) return undefined;
  return pkg.placements.find((placement) => placement.space_id === spaceId);
}

/**
 * Folds one activation into a cached snapshot. Deactivating keeps the placement (`DELETE` flips
 * `enabled`), so state walks `active ⇄ inactive`, never back to `none`. Activating where the
 * package is not placed shares and activates in one transaction, hence `via: "shared"`.
 */
function applyActivation(
  prev: LibraryResponse | undefined,
  packageId: string,
  spaceId: string,
  active: boolean,
): LibraryResponse | undefined {
  if (!prev) return prev;
  const mapGroup = (pkgs: LibraryPackageItem[]) =>
    pkgs.map((pkg) => {
      if (pkg.id !== packageId) return pkg;
      const known = pkg.placements.some((placement) => placement.space_id === spaceId);
      return {
        ...pkg,
        placements: known
          ? pkg.placements.map((placement) =>
              placement.space_id === spaceId
                ? { ...placement, state: active ? ("active" as const) : ("inactive" as const) }
                : placement,
            )
          : [
              ...pkg.placements,
              {
                space_id: spaceId,
                via: "shared" as const,
                state: active ? ("active" as const) : ("inactive" as const),
                shared_by: null,
                chat_enforced: false,
              },
            ],
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
 * Whether a package RUNS in the current space: `true`, `false`, or `undefined` ("the library says
 * nothing"). The library lists only what the caller may READ, and a `runner` holds `agents:run`
 * without `agents:read`, so a package ABSENT from the payload is `undefined` (never "inactive",
 * which would grey out a launch the server accepts). Readers test `=== false` / `=== true`.
 * The package's HOME is not derived here; it comes from the package's own detail
 * (`home_space_id`). Agent surfaces use `AgentDetail.active` instead; pass `enabled: false` from a
 * page that already holds the answer.
 */
export function usePackageActivationState(packageId: string, options: { enabled?: boolean } = {}) {
  const { data: libraryData } = useSpaceLibrary(options);
  const currentSpaceId = useCurrentSpaceId();
  return useMemo(
    () => activationStateOf(libraryData, packageId, currentSpaceId),
    [libraryData, packageId, currentSpaceId],
  );
}

/** The verdict above, as a pure function of the snapshot — see its doc. */
export function activationStateOf(
  library: Pick<LibraryResponse, "packages"> | undefined,
  packageId: string,
  spaceId: string | null,
): {
  isActiveInCurrentSpace: boolean | undefined;
  placement: LibraryPlacement | undefined;
} {
  const libraryPkg = library
    ? Object.values(library.packages)
        .flat()
        .find((p) => p.id === packageId)
    : undefined;
  if (!libraryPkg) return { isActiveInCurrentSpace: undefined, placement: undefined };
  const placement = placementIn(libraryPkg, spaceId);
  return {
    /** Placed here AND switched on — the exact predicate the run gate checks. */
    isActiveInCurrentSpace: placement?.state === "active",
    /** How it got here and what state it is in; `undefined` when not placed. */
    placement,
  };
}

/** Invalidates both library forms (organization's and current space's); one alone leaves the other stale. */
export function invalidateLibraries(qc: QueryClient) {
  return invalidatePaths(qc, ["/api/library", "/api/spaces/{spaceId}/library"]);
}

/** Activation changes affect the library and every space's package/agent cache. */
export function useInvalidatePackageActivation() {
  const qc = useQueryClient();
  return () => {
    void invalidateLibraries(qc);
    void qc.invalidateQueries({ queryKey: packageKeys.all });
    void qc.invalidateQueries({ queryKey: agentsKeys.all });
    void invalidateIntegrationQueries(qc);
  };
}

/**
 * No optimistic patch: the cap and the budget are the server's to judge. The
 * awaited invalidation keeps the box disabled until the refetch lands.
 */
export function useSetChatEnforced() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorHandledByCaller: true },
    mutationFn: async ({
      spaceId,
      packageId,
      enforced,
    }: {
      spaceId: string;
      packageId: string;
      enforced: boolean;
    }) => {
      const parsed = parseScopedName(packageId);
      if (!parsed) throw new Error(`Invalid packageId: ${packageId}`);
      await client.PATCH("/api/spaces/{spaceId}/packages/{scope}/{name}", {
        params: { path: { spaceId, scope: `@${parsed.scope}`, name: parsed.name } },
        body: { chat_enforced: enforced },
      });
    },
    onSuccess: (_data, { enforced }) =>
      toast.success(
        i18n.t(enforced ? "settings:packages.chatEnforced" : "settings:packages.chatUnenforced"),
      ),
    onSettled: () => invalidateLibraries(qc),
  });
}

/**
 * Activate / deactivate a package in one space, for all four families (`POST /api/spaces/{id}/packages`,
 * `DELETE .../{scope}/{name}`). `active: true` upserts (places, sharing from home when allowed) and
 * switches on; `false` switches off and keeps the row and its settings.
 */
export function useSetPackageActive() {
  const qc = useQueryClient();
  const invalidate = useInvalidatePackageActivation();
  const scope = useOrgOnlyScope();
  const currentSpaceId = useCurrentSpaceId();
  // Both library queries render the same row: patching only one snaps the clicked switch back until the refetch.
  const libraryKey = $api.queryOptions("get", "/api/library", {
    params: { header: scope.header },
  }).queryKey;
  const spaceLibraryKey = $api.queryOptions("get", "/api/spaces/{spaceId}/library", {
    params: { path: { spaceId: currentSpaceId ?? "" }, header: scope.header },
  }).queryKey;

  return useMutation({
    mutationFn: async ({
      spaceId,
      packageId,
      active,
    }: {
      spaceId: string;
      packageId: string;
      active: boolean;
    }) => {
      if (!active) {
        // Two path params, so the typed client never percent-encodes the scope/name `/`.
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
    onMutate: async ({ spaceId, packageId, active }) => {
      // The space form answers only for its own space: patched only for a write aimed at it.
      const keys: ReadonlyArray<readonly unknown[]> = [
        libraryKey,
        ...(spaceId === currentSpaceId ? [spaceLibraryKey] : []),
      ];
      const prev: Array<[readonly unknown[], LibraryResponse | undefined]> = [];
      for (const key of keys) {
        await qc.cancelQueries({ queryKey: key });
        prev.push([key, qc.getQueryData<LibraryResponse>(key)]);
        qc.setQueryData<LibraryResponse>(key, (old) =>
          applyActivation(old, packageId, spaceId, active),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, snapshot] of ctx?.prev ?? []) {
        if (snapshot) qc.setQueryData(key, snapshot);
      }
    },
    // Said here, once, for every surface that flips the switch.
    onSuccess: (_data, { active }) =>
      toast.success(
        i18n.t(active ? "settings:packages.activated" : "settings:packages.deactivated"),
      ),
    onSettled: invalidate,
  });
}

/** One package's switch in the current space: the server's two verdicts (`activation` on its library row) and the two acts. A row the library does not carry answers `false` both ways. */
export function usePackageActivation(packageId: string) {
  const setActive = useSetPackageActive();
  const spaceId = useCurrentSpaceId();
  const { data: library } = useSpaceLibrary();
  const row = useMemo(
    () =>
      library
        ? Object.values(library.packages)
            .flat()
            .find((pkg) => pkg.id === packageId)
        : undefined,
    [library, packageId],
  );
  const may = (next: boolean) => !!spaceId && !!row && activationGate(row, spaceId, next).allowed;
  const set = (active: boolean, options?: { onSuccess?: () => void }) => {
    if (spaceId) setActive.mutate({ spaceId, packageId, active }, options);
  };
  return {
    mayActivate: may(true),
    mayDeactivate: may(false),
    /** A placement someone else put here, which this caller may take out of the space. */
    mayRemove: !!row && mayRemoveFromSpace(row, spaceId),
    activate: (options?: { onSuccess?: () => void }) => set(true, options),
    deactivate: (options?: { onSuccess?: () => void }) => set(false, options),
    pending: setActive.isPending,
  };
}
