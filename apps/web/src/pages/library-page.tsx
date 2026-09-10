// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Package } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import type { PackageType } from "@appstrate/core/validation";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useLibrary, useTogglePackageInstall } from "../hooks/use-library";
import type { LibraryPackageItem, LibraryResponse, LibrarySpace } from "../hooks/use-library";
import { useSpaces } from "../hooks/use-spaces";
import { PACKAGE_PERMISSIONS } from "../lib/package-permissions";
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
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { packageDetailPath, splitPackageRef } from "../lib/package-paths";
import { useAcceptPackageShare } from "../hooks/use-package-shares";

const TABS = ["agents", "skills", "integrations"] as const;
type Tab = (typeof TABS)[number];

const TYPE_MAP: Record<Tab, PackageType> = {
  agents: "agent",
  skills: "skill",
  integrations: "integration",
};

export function LibraryPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useLibrary();
  const [activeTab, setActiveTab] = useTabWithHash(TABS, "agents");

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={getErrorMessage(error)} />;
  if (!data) return null;

  return (
    <div className="p-6">
      <PageHeader title={t("library.title")} />
      <SharedWithMe shared={data.shared} spaces={data.spaces} />
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
            <LibraryMatrix
              packages={data.packages[TYPE_MAP[tab]] ?? []}
              spaces={data.spaces}
              type={TYPE_MAP[tab]}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/**
 * The offers still waiting on a decision (RBAC spec §6.10). A share makes a
 * package READABLE; it never installs it, because it would run with the
 * recipient's own credentials — so accepting is a button the recipient presses.
 *
 * Which button depends on the destination, and there are two. An offer to the
 * caller's OWN personal space is accepted (`POST …/shares/accept`), which needs
 * no permission at all and pins the version. An offer to a TEAM space is an
 * ordinary install into that space, so it is offered only to a caller who holds
 * the type's install grant THERE — without a button of its own the row said
 * "offered in « T »" and left the reader to find the package in the matrix
 * below, having been told it was shared with them.
 */
function SharedWithMe({
  shared,
  spaces,
}: {
  shared: LibraryResponse["shared"];
  spaces: LibrarySpace[];
}) {
  const { t } = useTranslation();
  const accept = useAcceptPackageShare();
  const install = useTogglePackageInstall();
  const { data: accessibleSpaces } = useSpaces();
  if (shared.length === 0) return null;
  const spaceName = (id: string) => spaces.find((space) => space.id === id)?.name ?? id;
  /** The install grant in the OFFERED space — the target of this row's button. */
  const canInstallThere = (spaceId: string, type: string) =>
    accessibleSpaces
      ?.find((space) => space.id === spaceId)
      ?.permissions.includes(PACKAGE_PERMISSIONS[type as PackageType].install) ?? false;

  return (
    <div className="mb-6 rounded-lg border p-4">
      <h2 className="text-sm font-medium">{t("library.shared.title")}</h2>
      <p className="text-muted-foreground mt-0.5 text-xs">{t("library.shared.hint")}</p>
      <ul className="mt-3 divide-y">
        {shared.map((offer) => (
          <li key={`${offer.id}:${offer.space_id}`} className="flex items-center gap-3 py-2">
            <div className="min-w-0 flex-1">
              <Link
                to={packageDetailPath(offer.type, offer.id)}
                className="text-sm font-medium hover:underline"
              >
                {offer.name}
              </Link>
              <p className="text-muted-foreground truncate text-xs">
                {offer.personal
                  ? offer.shared_by
                    ? t("library.shared.by", { name: offer.shared_by.name })
                    : offer.description
                  : t("library.shared.inSpace", { space: spaceName(offer.space_id) })}
              </p>
            </div>
            {offer.personal ? (
              <Button
                size="sm"
                disabled={accept.isPending}
                onClick={() =>
                  accept.mutate(
                    { params: { path: splitPackageRef(offer.id) } },
                    {
                      onSuccess: () => toast.success(t("library.shared.added")),
                      onError: (err) => toast.error(getErrorMessage(err)),
                    },
                  )
                }
              >
                {t("library.shared.add")}
              </Button>
            ) : (
              canInstallThere(offer.space_id, offer.type) && (
                <Button
                  size="sm"
                  disabled={install.isPending}
                  onClick={() =>
                    install.mutate(
                      { spaceId: offer.space_id, packageId: offer.id, installed: false },
                      {
                        onSuccess: () =>
                          toast.success(
                            t("library.shared.installed", { space: spaceName(offer.space_id) }),
                          ),
                        onError: (err) => toast.error(getErrorMessage(err)),
                      },
                    )
                  }
                >
                  {t("library.shared.installIn", { space: spaceName(offer.space_id) })}
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LibraryMatrix({
  packages: pkgs,
  spaces,
  type,
}: {
  packages: LibraryPackageItem[];
  spaces: LibrarySpace[];
  type: PackageType;
}) {
  const { t } = useTranslation();
  const { data: accessibleSpaces } = useSpaces();
  const toggle = useTogglePackageInstall();
  // Re-accepting a share re-pins the caller's personal-space installation to
  // `latest` — the update button of the badge below.
  const update = useAcceptPackageShare();
  const permissionsBySpace = new Map(accessibleSpaces?.map((s) => [s.id, s.permissions]));
  const { install: installPermission, uninstall: uninstallPermission } = PACKAGE_PERMISSIONS[type];
  // Every column targets a different space. Installation state chooses the
  // operation; the target space's effective set decides whether it is allowed.
  const canToggle = (spaceId: string, installed: boolean) =>
    permissionsBySpace
      .get(spaceId)
      ?.includes(installed ? uninstallPermission : installPermission) ?? false;
  // Agents/skills treat a "system" package as globally available (locked on,
  // can't toggle). Integrations are different: they must be activated per
  // space even when system-sourced, so their system rows stay toggleable.
  const lockSystem = type !== "integration";

  if (pkgs.length === 0) {
    return <EmptyState message={t("library.empty")} icon={Package} />;
  }

  const handleToggle = (pkg: LibraryPackageItem, spaceId: string, installed: boolean) => {
    if (lockSystem && pkg.source === "system") return;
    if (!canToggle(spaceId, installed)) return;
    toggle.mutate(
      { spaceId, packageId: pkg.id, installed },
      {
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("error.generic"));
        },
      },
    );
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="min-w-[200px]">{t("library.column.package")}</TableHead>
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
        {pkgs.map((pkg) => (
          <TableRow key={pkg.id}>
            <TableCell>
              <div className="flex items-center gap-2">
                <Link to={packageDetailPath(type, pkg.id)} className="font-medium hover:underline">
                  {pkg.name}
                </Link>
                {pkg.source === "system" && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[0.6rem]">
                    {t("library.system")}
                  </Badge>
                )}
                {/* The caller's own personal space holds it at a version PIN
                    older than `latest`. Re-accepting is what takes the new
                    version — the same act that installed it. */}
                {pkg.update_available && (
                  <Badge variant="outline" className="px-1.5 py-0 text-[0.6rem]">
                    {t("library.updateAvailable")}
                  </Badge>
                )}
                {pkg.update_available && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 text-xs"
                    disabled={update.isPending}
                    onClick={() =>
                      update.mutate(
                        { params: { path: splitPackageRef(pkg.id) } },
                        {
                          onSuccess: () => toast.success(t("library.updateApplied")),
                          onError: (err) => toast.error(getErrorMessage(err)),
                        },
                      )
                    }
                  >
                    {t("library.updateApply")}
                  </Button>
                )}
              </div>
              {pkg.description && (
                <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
                  {pkg.description}
                </p>
              )}
            </TableCell>
            {spaces.map((space) => {
              const installed = pkg.installed_in.includes(space.id);
              const systemAlwaysActive = lockSystem && pkg.source === "system";
              const blocked = !canToggle(space.id, installed);
              // Until `useSpaces` resolves the caller's standing is unknown, so the
              // box is disabled without claiming a missing permission.
              const missingPermission = accessibleSpaces !== undefined && blocked;
              // Two different reasons the box cannot be clicked.
              const title = systemAlwaysActive
                ? t("library.systemAlwaysActive")
                : missingPermission
                  ? t(installed ? "library.cannotUninstall" : "library.cannotInstall")
                  : undefined;
              return (
                <TableCell key={space.id} className="text-center">
                  <Checkbox
                    checked={systemAlwaysActive || installed}
                    disabled={systemAlwaysActive || blocked}
                    title={title}
                    onCheckedChange={() => handleToggle(pkg, space.id, installed)}
                  />
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
