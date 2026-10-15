// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogue: what this space could be given, and what it already has, with
 * the kinds in the rail and each package's placement per space in the table.
 *
 * A SYSTEM package has no `space_packages` row of its own, so the deployment's
 * default decides "active here" (`isActiveHere`, `services/package-activation.ts`);
 * an explicit row outvotes it (the sticky opt-out). A system INTEGRATION is the
 * one kind the library cannot answer for (its offered set is a boot-time env
 * constant), so only `/api/integrations` is trusted for it.
 *
 * A row opens HERE, not on the package's page: that page would throw away the
 * panel and its breadcrumb would claim the current space for a package not in it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, LibraryBig, Share2, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@appstrate/ui/components/dropdown-menu";
import { cn } from "@appstrate/ui/cn";
import type { PackageType } from "@appstrate/core/validation";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { SHARE_PARAM, SharePackageDialog } from "./package-detail/share-package-dialog";
import { packageDetailPath, splitPackageRef } from "../lib/package-paths";
import { CATALOGUE_KINDS, CATALOGUE_VERSION_PARAM, catalogueHref } from "../lib/catalogue-link";
import { useOrg } from "../hooks/use-org";
import { useSpaces } from "../hooks/use-spaces";
import { useAgents } from "../hooks/use-packages";
import { mayConfigurePackage } from "../lib/package-permissions";
import { useRevokePackageShare } from "../hooks/use-package-shares";
import { useIntegrationsById } from "../hooks/use-integrations";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";
import {
  invalidateLibraries,
  useCatalogueLibrary,
  useSetPackageActive,
  type LibraryPackageItem,
} from "../hooks/use-library";
import { activationGate, catalogueDeeds } from "../lib/catalogue-gates";
import { cataloguePlacement, type CataloguePlacement } from "../lib/catalogue-placement";
import { useUrlModal, useUrlModalTarget } from "../hooks/use-url-modal";
import { useListParams } from "../lib/list-params";
import type { CardItem } from "../lib/package-card-item";
import { CataloguePreview } from "./catalogue-preview";
import { PageActionsMenu } from "./page-actions-menu";
import { PanelLayout } from "./panel-layout";
import { PackageCollection } from "./package-collection";
import { useCatalogueOriginColumn, useCatalogueSpaceColumns } from "./catalogue-columns";
import { RailLink } from "./settings/rail-link";
import { RailGroup, RailHeader } from "./settings/rail-shell";
import { SettingsHeading } from "./settings/settings-heading";

const TITLE_KEY: Record<PackageType, string> = {
  agent: "packages.type.agents",
  skill: "packages.type.skills",
  "mcp-server": "packages.type.mcp-servers",
  integration: "packages.type.integrations",
};

/**
 * Columns the catalogue drops. `origin` is drawn again with each package's home
 * space under its provider, and `keywords` goes because the library carries none.
 */
const CATALOGUE_DROPS = ["state", "actions", "origin", "keywords"];

/** The parameter that qualifies the sheet's `?package=`, and leaves with it. */
const SHEET_COMPANIONS = [CATALOGUE_VERSION_PARAM];

const toCardItem = (pkg: LibraryPackageItem): CardItem => ({
  id: pkg.id,
  displayName: pkg.name || pkg.id,
  description: pkg.description,
  type: pkg.type,
  source: pkg.source as CardItem["source"],
});

export function OrgCatalogueModal({ type: active }: { type: PackageType }) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const spaceId = useCurrentSpaceId();
  const { currentOrg } = useOrg();
  const { data: library, isLoading, error } = useCatalogueLibrary();
  const activate = useSetPackageActive();
  const list = useListParams(["origin"]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const titleKey = TITLE_KEY[active];
  const orgName = currentOrg?.name ?? "";

  // Integrations resolve their activation server-side; only their view pays for the request.
  const integrationsQuery = useIntegrationsById(
    (library?.packages.integration ?? []).map((item) => item.id),
    { enabled: active === "integration" },
  );
  const { data: integrations } = integrationsQuery;
  // The library carries no icon: agents and integrations get theirs from their own reads.
  const { data: agentsHere } = useAgents();
  const agentLook = new Map((agentsHere ?? []).map((agent) => [agent.id, agent] as const));
  const integrationById = new Map((integrations ?? []).map((row) => [row.id, row] as const));
  // The current space leads (not the server's default-first order): it is the column that
  // survives a narrow width (tier 2, in `useCatalogueSpaceColumns`).
  const spaces = [...(library?.spaces ?? [])].sort(
    (a, b) => Number(b.id === spaceId) - Number(a.id === spaceId),
  );
  // `/api/spaces` carries the grant of each space, the verdict a switch answers to.
  const { data: reachable } = useSpaces();
  const grantById = new Map((reachable ?? []).map((space) => [space.id, space] as const));

  // An INTEGRATION's "active here" comes from `/api/integrations`: a system one is ON in a
  // space with no row (`resolveIntegrationActivations`), which the library cannot see.
  const placementOf = (item: LibraryPackageItem): CataloguePlacement => {
    const base = cataloguePlacement(item, spaceId);
    if (active !== "integration") return base;
    const activeHere = Boolean(integrationById.get(item.id)?.active);
    if (!activeHere || !spaceId || base.here === "active") return base;
    return { ...base, here: "active", activeIn: [...base.activeIn, spaceId] };
  };

  const ofKind: LibraryPackageItem[] = library?.packages[active] ?? [];
  // The read has an address of its own: reload lands on it, Back leaves it.
  // Looked up in the whole kind, so a link to a package (a share notification)
  // opens its sheet whatever the list shows. An id the kind does not hold drops
  // from the address.
  const preview = useUrlModalTarget("package", library ? ofKind : undefined, {
    companions: SHEET_COMPANIONS,
  });
  const placementById = new Map(ofKind.map((item) => [item.id, placementOf(item)] as const));
  const spaceNameOf = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;
  const rowOf = (item: Pick<CardItem, "id">) => ofKind.find((row) => row.id === item.id);
  const deedsOf = (id: string) => {
    const row = rowOf({ id });
    return row ? catalogueDeeds(row) : undefined;
  };

  const share = useUrlModal(SHARE_PARAM);
  const revoke = useRevokePackageShare();
  // Targets the SPACE id; a share to a person publishes their user id instead, so that
  // offer is withdrawn from the package's share dialog.
  const revokeFrom = (packageId: string, targetSpaceId: string) =>
    revoke.mutate(
      { params: { path: { ...splitPackageRef(packageId), target: targetSpaceId } } },
      {
        onSuccess: () => {
          void invalidateLibraries(qc);
          toast.success(t("catalogue.revoked", { space: spaceNameOf(targetSpaceId) }));
        },
      },
    );

  const items: CardItem[] = ofKind.map((item) => {
    const look = agentLook.get(item.id);
    return {
      ...toCardItem(item),
      ...(active === "agent" && { identity: { icon: look?.icon, color: look?.color } }),
      ...(active === "integration" && { logo: integrationById.get(item.id)?.manifest.icon }),
    };
  });

  const previewed = preview.target;
  // A system package ships one definition and answers no version: the sheet reads it as is.
  const pinnedVersion =
    previewed && previewed.source !== "system"
      ? new URLSearchParams(location.search).get(CATALOGUE_VERSION_PARAM) || undefined
      : undefined;

  const originColumn = useCatalogueOriginColumn(orgName, (item) => {
    const home = placementById.get(item.id)?.homeSpaceId;
    // `null` when the caller does not reach the home: the server withholds the id (RBAC spec §6.9).
    return home ? spaceNameOf(home) : null;
  });
  const spaceColumns = useCatalogueSpaceColumns({
    spaces,
    currentSpaceId: spaceId,
    placementOf: (item) => placementById.get(item.id),
    gateOf: (item, targetSpaceId, next) => {
      const row = rowOf(item);
      return row ? activationGate(row, targetSpaceId, next) : { allowed: false, refusal: null };
    },
    busy: activate.isPending,
    onSetActive: (item, targetSpaceId, next) =>
      activate.mutate({ spaceId: targetSpaceId, packageId: item.id, active: next }),
  });

  const rail = (
    <div className="flex h-full flex-col">
      <RailHeader icon={LibraryBig} title={t("common:nav.catalogue")} />
      <div className="flex-1">
        <RailGroup title={t("catalogue.kinds")}>
          <nav className="flex flex-col gap-0.5" aria-label={t("catalogue.kinds")}>
            {CATALOGUE_KINDS.map((type) => (
              <RailLink
                key={type}
                item={{ to: catalogueHref(type), icon: PACKAGE_TYPE_ICON[type] }}
                label={t(TITLE_KEY[type])}
                count={library?.packages[type]?.length}
                active={type === active}
              />
            ))}
          </nav>
        </RailGroup>
      </div>
    </div>
  );

  const previewedDeeds = previewed ? catalogueDeeds(previewed) : undefined;

  return (
    <PanelLayout
      title={t("common:nav.catalogue")}
      rail={rail}
      // Where the reader is, kept in place while the pane scrolls: the kind
      // they are browsing, or the package they opened, with the way back.
      contentHeader={(stuck) =>
        previewed ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 shrink-0 gap-1.5"
              onClick={preview.close}
            >
              <ArrowLeft />
              {t("catalogue.back")}
            </Button>
            {/* The package's name belongs to the page below; the band borrows
                it only once that page has scrolled past its own title. */}
            <span
              className={cn(
                "duration-fast truncate text-sm font-medium transition-opacity",
                stuck ? "opacity-100" : "opacity-0",
              )}
            >
              {previewed.name || previewed.id}
            </span>
          </div>
        ) : (
          <span
            className={cn(
              "duration-fast text-sm font-semibold transition-opacity",
              stuck ? "opacity-100" : "opacity-0",
            )}
          >
            {t(titleKey)}
          </span>
        )
      }
    >
      {previewed && previewedDeeds ? (
        <CataloguePreview
          item={previewed}
          type={active}
          spaces={library?.spaces ?? []}
          placement={placementOf(previewed)}
          gateOf={(targetSpaceId, next) => activationGate(previewed, targetSpaceId, next)}
          mayConfigureIn={(targetSpaceId) =>
            mayConfigurePackage(grantById.get(targetSpaceId), active)
          }
          integrations={library?.packages.integration ?? []}
          agents={library?.packages.agent ?? []}
          pinnedVersion={pinnedVersion}
          actionsMenu={
            <PageActionsMenu>
              {/* The page lives in the current space: a package placed only elsewhere would 404. */}
              {(previewed.source === "system" || placementOf(previewed).here !== null) && (
                <DropdownMenuItem
                  onSelect={() => navigate(packageDetailPath(active, previewed.id))}
                >
                  <ExternalLink />
                  {t("catalogue.openFullPage")}
                </DropdownMenuItem>
              )}
              {previewedDeeds.share && (
                <DropdownMenuItem onSelect={() => share.open(previewed.id)}>
                  <Share2 />
                  {t("packages.share")}
                </DropdownMenuItem>
              )}
              {previewedDeeds.revokeFrom.length > 0 && <DropdownMenuSeparator />}
              {/* Withdrawing an offer removes the package from that space, with the
                  activation it backs: the placement IS the offer. */}
              {previewedDeeds.revokeFrom.map((fromSpaceId) => (
                <DropdownMenuItem
                  key={fromSpaceId}
                  className="text-destructive focus:text-destructive"
                  disabled={revoke.isPending}
                  onSelect={() => revokeFrom(previewed.id, fromSpaceId)}
                >
                  <X />
                  {t("catalogue.revokeFrom", { space: spaceNameOf(fromSpaceId) })}
                </DropdownMenuItem>
              ))}
            </PageActionsMenu>
          }
          busy={activate.isPending}
          onSetActive={(targetSpaceId, next) =>
            activate.mutate({ spaceId: targetSpaceId, packageId: previewed.id, active: next })
          }
        />
      ) : (
        <PackageCollection
          items={items}
          isLoading={isLoading || (active === "integration" && integrationsQuery.isLoading)}
          error={
            error instanceof Error
              ? error
              : active === "integration" && integrationsQuery.error instanceof Error
                ? integrationsQuery.error
                : null
          }
          holds={active}
          tableId={`catalogue-${active}`}
          entity={t(titleKey)}
          emptyMessage={t("catalogue.empty")}
          emptyHint={t("catalogue.emptyHint")}
          emptyIcon={PACKAGE_TYPE_ICON[active]}
          list={list}
          header={<SettingsHeading className="mb-4" title={t(titleKey)} />}
          // The library says where a package is placed, not what uses it: an activity filter would match nothing.
          activityFilter={false}
          originLabels={{
            title: t("catalogue.origin"),
            local: t("catalogue.sourceOrg", { name: orgName }),
            system: t("catalogue.sourceSystem"),
          }}
          dropColumns={CATALOGUE_DROPS}
          trailingColumns={[originColumn, ...spaceColumns]}
          rowAction={(item) => preview.open(item.id)}
        />
      )}

      {/* The dialog mounts only when its deed is the reader's; a URL names the shared package. */}
      {share.value && deedsOf(share.value)?.share && (
        <SharePackageDialog
          onClose={share.close}
          packageId={share.value}
          type={active}
          homeSpaceId={placementById.get(share.value)?.homeSpaceId}
          canPublish={rowOf({ id: share.value })?.home_writable === true}
        />
      )}
    </PanelLayout>
  );
}
