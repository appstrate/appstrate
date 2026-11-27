// SPDX-License-Identifier: Apache-2.0

import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { integrationIdOfField } from "../lib/connection-choice";
import { useSpaces, useSpacesOf } from "./use-spaces";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { parseScopedName } from "@appstrate/core/naming";
import { $api, client, type paths } from "../api/client";
import { useCurrentSpaceId } from "./use-current-space";
import { agentsKeys, invalidatePaths, packageKeys } from "../lib/query-keys";
import { invalidateIntegrationQueries } from "./use-integrations";
import { useOrgOnlyScope } from "./use-org-scope";
import { splitPackageRef } from "../lib/package-paths";
import { activationGate, mayRemoveFromSpace, type ActivationGate } from "../lib/catalogue-gates";

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

/** The working space's library; `enabled: false` reads only the cache. */
function useSpaceLibrary(options: { enabled?: boolean } = {}) {
  const scope = useOrgOnlyScope();
  const spaceId = useCurrentSpaceId();
  return $api.useQuery(
    "get",
    "/api/spaces/{id}/library",
    { params: { path: { id: spaceId ?? "" }, header: scope.header } },
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
              },
            ],
      };
    });
  return {
    ...prev,
    packages: {
      agent: mapGroup(prev.packages.agent),
      skill: mapGroup(prev.packages.skill),
      integration: mapGroup(prev.packages.integration),
    },
  };
}

/** A placement change affects both libraries and the readable spaces used by direct links. */
export function invalidateLibraries(qc: QueryClient) {
  return invalidatePaths(qc, [
    "/api/library",
    "/api/spaces/{id}/library",
    "/api/packages/{scope}/{name}/home",
  ]);
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
 * Activate / deactivate a package in one space, for every package family (`POST /api/spaces/{id}/packages`,
 * `DELETE .../{scope}/{name}`). `active: true` upserts (places, sharing from home when allowed) and
 * switches on; `false` switches off and keeps the row and its settings.
 */
export function useSetPackageActive() {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const invalidate = useInvalidatePackageActivation();
  const scope = useOrgOnlyScope();
  const currentSpaceId = useCurrentSpaceId();
  // Both libraries render the row: both are patched.
  const libraryKey = $api.queryOptions("get", "/api/library", {
    params: { header: scope.header },
  }).queryKey;
  const spaceLibraryKey = $api.queryOptions("get", "/api/spaces/{id}/library", {
    params: { path: { id: currentSpaceId ?? "" }, header: scope.header },
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
        await client.DELETE("/api/spaces/{id}/packages/{scope}/{name}", {
          params: {
            path: { id: spaceId, scope: `@${parsed.scope}`, name: parsed.name },
          },
        });
        return;
      }
      const { data } = await client.POST("/api/spaces/{id}/packages", {
        params: { path: { id: spaceId } },
        body: { packageId },
      });
      return data?.warnings;
    },
    onSuccess: (warnings, { packageId }) => {
      for (const warning of warnings ?? []) {
        toast.warning(
          t(warning.required ? "catalogue.inactiveRequired" : "catalogue.inactiveOptional", {
            agent: packageId,
            integration: integrationIdOfField(warning.field),
          }),
        );
      }
    },
    onMutate: async ({ spaceId, packageId, active }) => {
      // The space library holds the working space only.
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

/** `packageId`'s row in a library snapshot, of any type. */
function libraryRow(
  library: Pick<LibraryResponse, "packages"> | undefined,
  packageId: string,
): LibraryPackageItem | undefined {
  return library
    ? Object.values(library.packages)
        .flat()
        .find((pkg) => pkg.id === packageId)
    : undefined;
}

/**
 * One package's placement switches (`usePlacementDeeds` turns them into deeds), over every space
 * of `/api/library` with `spanning`, else the working space's library: `activateIn` (off or not
 * placed, and the reader may switch it on), `deactivateIn` (runs, and may be switched off),
 * `removeFrom` (a share the reader may take out). In the library's space order.
 */
export function usePackageActivationInSpaces(
  packageId: string,
  { spanning }: { spanning: boolean },
) {
  const setActive = useSetPackageActive();
  const workingSpaceId = useCurrentSpaceId();
  const { data: orgLibrary } = useCatalogueLibrary({ enabled: spanning });
  const { data: spaceLibrary } = useSpaceLibrary({ enabled: !spanning });
  const library = spanning ? orgLibrary : spaceLibrary;
  const row = libraryRow(library, packageId);
  const spaceIds = !row
    ? []
    : spanning
      ? (library?.spaces ?? []).map((space) => space.id)
      : workingSpaceId
        ? [workingSpaceId]
        : [];
  const targets = useSpacesOf(spaceIds);
  const runsIn = (spaceId: string) => placementIn(row!, spaceId)?.state === "active";
  return {
    activateIn: targets.filter(({ id }) => !runsIn(id) && activationGate(row!, id, true).allowed),
    deactivateIn: targets.filter(({ id }) => runsIn(id) && activationGate(row!, id, false).allowed),
    removeFrom: targets.filter(({ id }) => mayRemoveFromSpace(row!, id)),
    setActive: (spaceId: string, active: boolean, options?: { onSuccess?: () => void }) =>
      setActive.mutate({ spaceId, packageId, active }, options),
    pending: setActive.isPending,
  };
}

/** The working space's « Activer »: whether its library row lets the reader switch it on, and the act. */
export function usePackageActivation(
  packageId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const setActive = useSetPackageActive();
  const spaceId = useCurrentSpaceId();
  const { data: library, isLoading: libraryLoading } = useSpaceLibrary({ enabled });
  const spaceRow = libraryRow(library, packageId);
  const { data: spaces } = useSpaces();
  const personal = !!spaces?.find((space) => space.id === spaceId)?.personal;
  // A team space not holding the package lacks it from its library: the org-wide library's
  // per-space `activation` verdict answers then. A personal space holds only what it creates
  // and what the organization offers, so the package's absence there is the refusal.
  const { data: orgLibrary, isLoading: orgLoading } = useCatalogueLibrary({
    enabled: enabled && !!library && !spaceRow && !personal,
  });
  const row = spaceRow ?? (personal ? undefined : libraryRow(orgLibrary, packageId));
  const gate: ActivationGate | null =
    spaceId && row
      ? activationGate(row, spaceId, true)
      : personal && library && !spaceRow
        ? { allowed: false, refusal: "notOffered" }
        : null;
  return {
    mayActivate: !!gate?.allowed,
    /** Why the server refuses; `null` when allowed or no verdict names a reason. */
    refusal: gate?.refusal ?? null,
    /** The libraries that decide `mayActivate` are still loading: a refusal is not known yet. */
    loading: libraryLoading || orgLoading,
    activate: (options?: { onSuccess?: () => void }) => {
      if (spaceId) setActive.mutate({ spaceId, packageId, active: true }, options);
    },
    pending: setActive.isPending,
  };
}

/** How an offer to the organization reaches the spaces holding no row of their own. */
export type OrgOfferMode = NonNullable<LibraryPackageItem["org_offer"]>;

/**
 * Offers `packageId` to the organization in `mode` (`PUT …/org-offer`) and answers its `warnings[]`
 * (the integrations an offered agent declares that the organization does not offer), or withdraws
 * the offer when `mode` is `null` (`DELETE`).
 */
export async function setOrgOffer(packageId: string, mode: OrgOfferMode | null) {
  const params = { params: { path: splitPackageRef(packageId) } };
  if (!mode) {
    await client.DELETE("/api/packages/{scope}/{name}/org-offer", params);
    return [];
  }
  const { data } = await client.PUT("/api/packages/{scope}/{name}/org-offer", {
    ...params,
    body: { mode },
  });
  return data?.warnings ?? [];
}

/** The offer changes where the package runs in every space without a row of its own: both libraries and every package cache refresh. */
export function useSetOrgOffer() {
  const invalidate = useInvalidatePackageActivation();
  return useMutation({
    mutationFn: ({ packageId, mode }: { packageId: string; mode: OrgOfferMode | null }) =>
      setOrgOffer(packageId, mode),
    onSettled: invalidate,
  });
}

/** Offers each package of `requests` in turn (one `PUT …/org-offer` each), then refreshes like {@link useSetOrgOffer}. */
export function useOfferOrgClosure() {
  const invalidate = useInvalidatePackageActivation();
  return useMutation({
    mutationFn: async (requests: { packageId: string; mode: OrgOfferMode }[]) => {
      for (const { packageId, mode } of requests) await setOrgOffer(packageId, mode);
    },
    onSettled: invalidate,
  });
}
