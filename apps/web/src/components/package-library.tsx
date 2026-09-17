// SPDX-License-Identifier: Apache-2.0

/**
 * The library, in both of its forms, as ONE projection of the placement model.
 *
 * A package lives in exactly one space (its home) and reaches others through a
 * share; either way its presence in a space is a PLACEMENT, whose local
 * instance is switched on and off rather than created and destroyed. Both views
 * below render the same `placements` array:
 *
 *   - the ORGANIZATION library (`GET /api/library`, owners and admins) is the
 *     map: per package, its home, who it is shared with, and where it is on.
 *     Every cell is actionable. Switching on a space the package is not placed
 *     in shares it there and activates it in one click, in one transaction,
 *     which is why no separate "share, then activate" exists.
 *   - one SPACE's view (`GET /api/spaces/{id}/library`) is the inventory of
 *     what is placed HERE, with its origin in words and one switch. A pending
 *     offer is not a separate inbox: it is a placement whose state is `none`.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FolderInput, Package, Share2, X } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import type { PackageType } from "@appstrate/core/validation";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "./page-states";
import { placementIn, useSetPackageActive } from "../hooks/use-library";
import type {
  LibraryPackageItem,
  LibraryPlacement,
  LibraryResponse,
  LibrarySpace,
} from "../hooks/use-library";
import { useSpaces } from "../hooks/use-spaces";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useRevokePackageShare } from "../hooks/use-package-shares";
import { maySetPackageActive, type SpaceGrant } from "../lib/package-permissions";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@appstrate/ui/components/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@appstrate/ui/components/table";
import { Button } from "@appstrate/ui/components/button";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Badge } from "@appstrate/ui/components/badge";
import { packageDetailPath, splitPackageRef } from "../lib/package-paths";
import { MoveHomeSpaceDialog } from "./package-detail/move-home-space-dialog";
import { SharePackageDialog } from "./package-detail/share-package-dialog";

const TABS = ["agents", "skills", "mcpServers", "integrations"] as const;
type Tab = (typeof TABS)[number];

const TYPE_MAP: Record<Tab, PackageType> = {
  agents: "agent",
  skills: "skill",
  mcpServers: "mcp-server",
  integrations: "integration",
};

type LibraryData = Pick<LibraryResponse, "packages" | "spaces">;

/** The tab strip both views share; only the table under it differs. */
/**
 * An offer nobody has taken up — `via: "shared"` with no placement row behind
 * it (RBAC spec §6.8). The server already answers both halves; this names the
 * pair so the two components that render it cannot drift into two readings of
 * the same cell.
 */
function isUntakenOffer(placement: LibraryPlacement | undefined): boolean {
  return placement?.via === "shared" && placement.state === "none";
}

function LibraryTabs({
  data,
  title,
  hint,
  renderTable,
}: {
  data: LibraryData;
  title: string;
  hint?: string;
  renderTable: (packages: LibraryPackageItem[], type: PackageType) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useTabWithHash(TABS, "agents");

  return (
    <div className="p-6">
      <PageHeader title={title} />
      {hint && <p className="text-muted-foreground mb-4 text-sm">{hint}</p>}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`library.tab.${tab}`)}
              <span className="text-muted-foreground ml-1.5 text-xs">
                {data.packages[TYPE_MAP[tab]]?.length ?? 0}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((tab) => (
          <TabsContent key={tab} value={tab}>
            {renderTable(data.packages[TYPE_MAP[tab]] ?? [], TYPE_MAP[tab])}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/**
 * The grants the caller holds per space, from `GET /api/spaces` — the library
 * route carries names, not permissions. `undefined` until it resolves, which
 * every control below reads as "not yet", never as "refused".
 */
function useSpaceGrants(): Map<string, SpaceGrant> | undefined {
  const { data: spaces } = useSpaces();
  return useMemo(
    () =>
      spaces &&
      new Map(
        spaces.map((space) => [
          space.id,
          { permissions: space.permissions, personal: space.personal, access: space.access },
        ]),
      ),
    [spaces],
  );
}

/** The package's name, a link when this caller can open its page. */
function PackageName({
  pkg,
  type,
  spaceId,
}: {
  pkg: LibraryPackageItem;
  type: PackageType;
  spaceId: string | null;
}) {
  const { t } = useTranslation();
  // The detail route is space-scoped: it opens on a package the CURRENT space
  // reads, which is exactly "placed here" — plus system packages, readable
  // everywhere. Naming a package the reader cannot open would be a dead link.
  const reachable = pkg.source === "system" || placementIn(pkg, spaceId) !== undefined;
  return (
    <>
      <div className="flex items-center gap-2">
        {reachable ? (
          <Link to={packageDetailPath(type, pkg.id)} className="font-medium hover:underline">
            {pkg.name}
          </Link>
        ) : (
          <span className="font-medium">{pkg.name}</span>
        )}
        {pkg.source === "system" && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[0.6rem]">
            {t("library.system")}
          </Badge>
        )}
      </div>
      {pkg.description && (
        <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">{pkg.description}</p>
      )}
    </>
  );
}

/**
 * One activation switch, for one (package, space).
 *
 * Two different refusals hide behind a dead box, and they are not the same
 * sentence: the caller may lack the activation grant in THIS space, or the
 * package may not be placed here at all — in which case switching it on is
 * really a share out of its home, and asks for `home_shareable` on top.
 *
 * A SYSTEM package has no third refusal: "active here" has one definition for
 * all four families — the row wins, its absence means the deployment default —
 * so a system package is switched off per space like any other, and the row it
 * materializes is the sticky opt-out.
 *
 * A live box on an untaken offer carries `consentHint` instead: switching it on
 * is a consent, not a setting (R17), and the sentence belongs where the click
 * happens. Only the SPACE view supplies it — there the reader is the one whose
 * credentials the package would run on, which is the whole sentence; on the
 * organization map the admin is switching it on in somebody else's space.
 */
function ActivationCheckbox({
  pkg,
  type,
  space,
  grants,
  setActive,
  consentHint,
}: {
  pkg: LibraryPackageItem;
  type: PackageType;
  space: LibrarySpace;
  grants: Map<string, SpaceGrant> | undefined;
  /**
   * The table's ONE activation mutation, handed down rather than called here:
   * a cell is `packages × spaces` of the open tab, and a `useMutation` per cell
   * buys nothing a shared one does not already give. Pending is narrowed back
   * to the cell that asked for it through the mutation's own variables, so one
   * click greys out one box and not the whole column.
   */
  setActive: ReturnType<typeof useSetPackageActive>;
  /** What taking up an untaken offer means, when the reader is its recipient. */
  consentHint?: string;
}) {
  const { t } = useTranslation();
  const placement = placementIn(pkg, space.id);
  const active = placement?.state === "active";
  const placed = placement !== undefined;
  // Switching on a space the package does not reach yet SHARES it there first.
  // A system package is placed everywhere by construction, so this half never
  // stands in its way.
  const mayPlace = placed || pkg.home_shareable;
  const mayToggle = maySetPackageActive(grants?.get(space.id), type, !active);
  const blocked = !mayPlace || !mayToggle;
  // An offer nobody has taken up: what saying yes means rides the box itself
  // and not only a page header the reader scrolled past.
  const untakenOffer = isUntakenOffer(placement);

  const title =
    // Until `useSpaces` resolves the caller's standing is unknown, so the box
    // is disabled without claiming a missing permission.
    grants === undefined
      ? undefined
      : !mayPlace
        ? t("library.cannotShareHere")
        : !mayToggle
          ? t(active ? "library.cannotDeactivate" : "library.cannotActivate")
          : untakenOffer
            ? consentHint
            : undefined;

  const pending =
    setActive.isPending &&
    setActive.variables?.packageId === pkg.id &&
    setActive.variables.spaceId === space.id;

  return (
    <Checkbox
      checked={active}
      disabled={blocked || pending}
      // The accessible name identifies the CELL, and never moves with the
      // refusal: a `<button role="checkbox">` takes its name from nothing else
      // here, the space is named only in a header cell nothing links it to, and
      // `title` is a reason, not a name. Without this every row announces four
      // "checkbox, not checked" and no query by role+name can reach one.
      aria-label={t("library.toggleIn", { space: space.name, package: pkg.name })}
      title={title}
      onCheckedChange={() => {
        if (blocked) return;
        setActive.mutate(
          { spaceId: space.id, packageId: pkg.id, active: !active },
          {
            onError: (err) => toast.error(getErrorMessage(err) || t("error.generic")),
          },
        );
      }}
    />
  );
}

// ─── Organization library: the placement map ────────────────────────────────

export function PackageLibrary({ data, title }: { data: LibraryData; title: string }) {
  return (
    <LibraryTabs
      data={data}
      title={title}
      renderTable={(packages, type) => (
        <PlacementMap packages={packages} spaces={data.spaces} type={type} />
      )}
    />
  );
}

function PlacementMap({
  packages: pkgs,
  spaces,
  type,
}: {
  packages: LibraryPackageItem[];
  spaces: LibrarySpace[];
  type: PackageType;
}) {
  const { t } = useTranslation();
  const grants = useSpaceGrants();
  const setActive = useSetPackageActive();
  const revoke = useRevokePackageShare();
  // The catalog reads every space at once and stands in none, but the detail
  // route it links to is scoped to the space the reader is IN — so a name is a
  // link only where that space reads the package.
  const currentSpaceId = useCurrentSpaceId();
  // ONE dialog of each kind for the whole table: they are modal, so at most one
  // is ever open, and mounting a pair per row would mount a few hundred.
  const [dialog, setDialog] = useState<{
    kind: "move" | "share";
    pkg: LibraryPackageItem;
  } | null>(null);

  if (pkgs.length === 0) {
    return <EmptyState message={t("library.empty")} icon={Package} />;
  }

  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;

  return (
    <>
      <MoveHomeSpaceDialog
        open={dialog?.kind === "move"}
        onClose={() => setDialog(null)}
        packageId={dialog?.pkg.id ?? ""}
        type={type}
        homeSpaceId={dialog?.pkg.home_space_id}
      />
      <SharePackageDialog
        open={dialog?.kind === "share"}
        onClose={() => setDialog(null)}
        packageId={dialog?.pkg.id ?? ""}
        type={type}
        homeSpaceId={dialog?.pkg.home_space_id}
        canPublish={!!dialog?.pkg.home_writable}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead rowSpan={2} className="min-w-[200px]">
              {t("library.column.package")}
            </TableHead>
            <TableHead rowSpan={2}>{t("library.column.home")}</TableHead>
            <TableHead rowSpan={2}>{t("library.column.sharedWith")}</TableHead>
            <TableHead colSpan={spaces.length} className="text-center">
              {t("library.column.activeIn")}
            </TableHead>
          </TableRow>
          <TableRow>
            {spaces.map((space) => (
              <TableHead key={space.id} className="text-center">
                <span className="text-xs">{space.name}</span>
                {space.isDefault && (
                  <Badge variant="outline" className="ml-1 px-1 py-0 text-[0.6rem]">
                    default
                  </Badge>
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pkgs.map((pkg) => {
            const sharedInto = pkg.placements.filter((placement) => placement.via === "shared");
            return (
              <TableRow key={pkg.id}>
                <TableCell>
                  <PackageName pkg={pkg} type={type} spaceId={currentSpaceId} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    {pkg.home_space_id ? (
                      <span className="text-sm">{spaceName(pkg.home_space_id)}</span>
                    ) : (
                      <span
                        className="text-muted-foreground text-sm"
                        title={t("library.home.unknownHint")}
                      >
                        —
                      </span>
                    )}
                    {pkg.home_writable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        title={t("library.moveHome")}
                        aria-label={t("library.moveHome")}
                        onClick={() => setDialog({ kind: "move", pkg })}
                      >
                        <FolderInput size={13} />
                      </Button>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    {sharedInto.map((placement) => (
                      <Badge
                        key={placement.space_id}
                        variant="outline"
                        className="gap-1 px-1.5 py-0 text-[0.65rem]"
                      >
                        {spaceName(placement.space_id)}
                        {pkg.home_shareable && (
                          <button
                            type="button"
                            className="hover:text-destructive"
                            title={t("library.revokeShare")}
                            aria-label={t("library.revokeShare")}
                            disabled={revoke.isPending}
                            onClick={() =>
                              revoke.mutate(
                                {
                                  params: {
                                    path: {
                                      ...splitPackageRef(pkg.id),
                                      target: placement.space_id,
                                    },
                                  },
                                },
                                { onError: (err) => toast.error(getErrorMessage(err)) },
                              )
                            }
                          >
                            <X size={10} />
                          </button>
                        )}
                      </Badge>
                    ))}
                    {pkg.home_shareable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        title={t("library.addShare")}
                        aria-label={t("library.addShare")}
                        onClick={() => setDialog({ kind: "share", pkg })}
                      >
                        <Share2 size={13} />
                      </Button>
                    )}
                  </div>
                </TableCell>
                {spaces.map((space) => {
                  // An offer nobody has taken up and a placement somebody
                  // switched OFF are the same unchecked box, and they ask for
                  // opposite decisions — renew the offer, or respect the
                  // refusal. `SpacePlacements` names them beside its own
                  // switch; the map says it in the same words, because a reason
                  // that only surfaces on hover is not read in a table scan.
                  const placement = placementIn(pkg, space.id);
                  return (
                    <TableCell key={space.id} className="text-center">
                      <span className="inline-flex items-center justify-center gap-1.5">
                        <ActivationCheckbox
                          pkg={pkg}
                          type={type}
                          space={space}
                          grants={grants}
                          setActive={setActive}
                        />
                        {isUntakenOffer(placement) && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                            {t("library.badge.offered")}
                          </Badge>
                        )}
                        {placement?.state === "inactive" && (
                          <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                            {t("library.badge.inactive")}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

// ─── One space: what is placed here ─────────────────────────────────────────

export function SpacePackageLibrary({ data, title }: { data: LibraryData; title: string }) {
  const { t } = useTranslation();
  // The space form narrows `spaces` to the one space it answers about, so this
  // is that space — not a guess from the space store, which a stale render
  // could disagree with.
  const space = data.spaces[0];
  return (
    <LibraryTabs
      data={data}
      title={title}
      hint={t("library.spaceHint")}
      renderTable={(packages, type) =>
        space ? (
          <SpacePlacements packages={packages} space={space} type={type} />
        ) : (
          // The route answers about one space and names it; without that name
          // there is no column to read a placement against. Say "nothing here"
          // rather than render a page that is silently blank.
          <EmptyState message={t("library.empty")} icon={Package} />
        )
      }
    />
  );
}

function SpacePlacements({
  packages: pkgs,
  space,
  type,
}: {
  packages: LibraryPackageItem[];
  space: LibrarySpace;
  type: PackageType;
}) {
  const { t } = useTranslation();
  const grants = useSpaceGrants();
  const setActive = useSetPackageActive();

  if (pkgs.length === 0) {
    return <EmptyState message={t("library.empty")} icon={Package} />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-[200px]">{t("library.column.package")}</TableHead>
          <TableHead>{t("library.column.origin")}</TableHead>
          <TableHead className="text-center">{t("library.column.active")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {pkgs.map((pkg) => {
          const placement = placementIn(pkg, space.id);
          return (
            <TableRow key={pkg.id}>
              <TableCell>
                <PackageName pkg={pkg} type={type} spaceId={space.id} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground text-xs">
                    {placement?.via === "home"
                      ? t("library.origin.home")
                      : placement?.via === "shared"
                        ? placement.shared_by
                          ? // A person offered it. Naming them is the whole
                            // point: activating it runs it with the reader's
                            // own credentials, so they get to know whose work
                            // they are about to take on.
                            t("library.origin.sharedBy", { name: placement.shared_by.name })
                          : // No author: the share was minted by a home move,
                            // which leaves the source space reading a package
                            // it no longer homes.
                            t("library.origin.shared")
                        : placement || pkg.source === "system"
                          ? t("library.origin.system")
                          : // No placement at all, and not a system package: the
                            // route lists it here because this caller could put
                            // it here in one click (they administer the
                            // organization's packages, or hold `share` in its
                            // home). It is a candidate, not an inhabitant.
                            t("library.origin.notPlaced")}
                  </span>
                  {isUntakenOffer(placement) && (
                    <Badge
                      variant="outline"
                      className="px-1.5 py-0 text-[0.65rem]"
                      title={t("library.offerHint")}
                    >
                      {t("library.badge.offered")}
                    </Badge>
                  )}
                  {placement?.state === "inactive" && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                      {t("library.badge.inactive")}
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-center">
                <ActivationCheckbox
                  pkg={pkg}
                  type={type}
                  space={space}
                  grants={grants}
                  setActive={setActive}
                  consentHint={t("library.offerHint")}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
