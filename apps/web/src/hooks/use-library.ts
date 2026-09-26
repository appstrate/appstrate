// SPDX-License-Identifier: Apache-2.0

import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseScopedName } from "@appstrate/core/naming";
import { $api, client, type paths } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { agentsKeys, packageKeys } from "../lib/query-keys";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useOrgOnlyScope } from "./use-org-scope";

/**
 * Wire shape from the OpenAPI spec (`GET /api/library`) — the organization
 * catalog: every package, and where each one is PLACED. The space form
 * (`GET /api/spaces/{id}/library`) is the same shape with the placements
 * narrowed to the one space, so both views read the same row.
 */
export type LibraryResponse =
  paths["/api/library"]["get"]["responses"][200]["content"]["application/json"];

export type LibraryPackageItem = LibraryResponse["packages"]["agent"][number];

export type LibrarySpace = LibraryResponse["spaces"][number];

/**
 * Where one package sits in one space, on the only two axes that exist: how it
 * got there (`via`) and whether it runs there (`state`). `state: "none"` is a
 * placement with no local instance yet — a pending offer is exactly that.
 */
export type LibraryPlacement = LibraryPackageItem["placements"][number];

export function useLibrary() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/library",
    { params: { header: scope.header } },
    { enabled: scope.enabled },
  );
}

/**
 * Space readers never need access to the organization administration view.
 *
 * `enabled: false` is for the caller that already holds the answer from a
 * narrower response — a package's own detail — and must not spend a second
 * round trip restating it. A snapshot another component on the page fetched is
 * still read from the cache.
 */
export function useSpaceLibrary(options: { enabled?: boolean } = {}) {
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
export function placementIn(
  pkg: Pick<LibraryPackageItem, "placements">,
  spaceId: string | null | undefined,
): LibraryPlacement | undefined {
  if (!spaceId) return undefined;
  return pkg.placements.find((placement) => placement.space_id === spaceId);
}

/**
 * Fold one activation into a cached library snapshot.
 *
 * Deactivating never removes the placement — the row and its settings survive
 * (`DELETE` flips `enabled`), so the state walks `active ⇄ inactive` and never
 * back to `none`. Activating a space the package is not placed in at all is the
 * admin's one click: the server shares it there and activates in one
 * transaction, so the optimistic row appears as `via: "shared"`.
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
                // A placement this click creates was imposed on nothing yet.
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
 * Whether a package RUNS in the current space — `true`, `false`, or "the
 * library has nothing to say about it".
 *
 * The third answer is not pedantry. `GET /api/spaces/{id}/library` lists, per
 * family, only what the caller may READ of that family, and the permission sets
 * do not line up with the run gate: a `runner` holds `agents:run` and no
 * `agents:read`, so the library answers with no agents at all for the very
 * caller most likely to be looking at a launch button. Reading that silence as
 * "not active here" greys out a control the server would have accepted, which
 * is the exact failure the tri-state exists to prevent — so a package ABSENT
 * from the payload is `undefined`, and only a package the payload carries can
 * be called inactive. Every reader tests `=== false` / `=== true`.
 *
 * The package's HOME is deliberately NOT derived here: it comes from the
 * package's own detail response (`home_space_id`), because a cache built for
 * activation state is not the authority on who may write the package.
 *
 * The same reasoning applies to activation wherever a detail response carries
 * it — an agent's own read answers `AgentDetail.active`, and the indexes list
 * the ACTIVE set, so no agent surface reads this projection and the `runner`
 * blind spot above never reaches a launch control. What is left is the families
 * whose detail carries no such field: a skill or an MCP server. Pass
 * `enabled: false` from a page that already holds the answer.
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
  // Not answered yet, or answered without this package in it — the two read the
  // same way here, and neither is a refusal.
  if (!libraryPkg) return { isActiveInCurrentSpace: undefined, placement: undefined };
  const placement = placementIn(libraryPkg, spaceId);
  return {
    /** Placed here AND switched on — the exact predicate the run gate checks. */
    isActiveInCurrentSpace: placement?.state === "active",
    /** How it got here and what state it is in; `undefined` when not placed. */
    placement,
  };
}

/** Activation changes affect the library and every space's package/agent cache. */
export function useInvalidatePackageActivation() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/library"] });
    void qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{spaceId}/library"] });
    void qc.invalidateQueries({ queryKey: packageKeys.all });
    void qc.invalidateQueries({ queryKey: agentsKeys.all });
    void invalidateIntegrationQueries(qc);
  };
}

/**
 * Impose a skill on every chat conversation of one space, or release it
 * (`PATCH /api/spaces/{id}/packages/{scope}/{name}` with `chat_enforced`).
 *
 * No optimistic patch: imposing is refused for reasons only the server can
 * judge (a published version, the per-space cap, the shared content budget), so
 * the box moves when the library says it did. The invalidation is awaited, so
 * the mutation stays pending — and the box disabled — until the refetch lands.
 */
export function useSetChatEnforced() {
  const qc = useQueryClient();
  return useMutation({
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
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["get", "/api/library"] }),
        qc.invalidateQueries({ queryKey: ["get", "/api/spaces/{spaceId}/library"] }),
      ]),
  });
}

/**
 * Activate or deactivate a package in one space — the single pair of doors,
 * for all four package families (`POST /api/spaces/{id}/packages`,
 * `DELETE /api/spaces/{id}/packages/{scope}/{name}`).
 *
 * `active: true` is an upsert: it places the package (sharing it from its home
 * when the caller may) and switches it on. `active: false` switches it off and
 * leaves the row — the model, proxy and generation settings chosen here are
 * still there when it comes back on.
 */
export function useSetPackageActive() {
  const qc = useQueryClient();
  const invalidate = useInvalidatePackageActivation();
  const scope = useOrgOnlyScope();
  const currentSpaceId = useCurrentSpaceId();
  // Exact keys of the two library queries (same init) for the optimistic
  // update. Both render the same row, so patching only one of them leaves the
  // switch the user just clicked snapping back until the refetch lands.
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
        // The deactivate route splits the `@scope/name` package id into two
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
    onMutate: async ({ spaceId, packageId, active }) => {
      // The space form only ever answers about the space it was read from, so
      // it is patched for a write aimed at that same space and left alone
      // otherwise.
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
    onSettled: invalidate,
  });
}
