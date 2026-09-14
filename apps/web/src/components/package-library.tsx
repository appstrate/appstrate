// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Package } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import type { PackageType } from "@appstrate/core/validation";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "./page-states";
import { SharedWithMe } from "./package-offers";
import { useTogglePackageInstall } from "../hooks/use-library";
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
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useAcceptPackageShare } from "../hooks/use-package-shares";

const TABS = ["agents", "skills", "mcpServers", "integrations"] as const;
type Tab = (typeof TABS)[number];

const TYPE_MAP: Record<Tab, PackageType> = {
  agents: "agent",
  skills: "skill",
  mcpServers: "mcp-server",
  integrations: "integration",
};

export function PackageLibrary({ data, title }: { data: LibraryResponse; title: string }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useTabWithHash(TABS, "agents");

  return (
    <div className="p-6">
      <PageHeader title={title} />
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
  const currentSpaceId = useCurrentSpaceId();
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
                {pkg.source === "system" ||
                (currentSpaceId &&
                  (pkg.home_space_id === currentSpaceId ||
                    pkg.installed_in.includes(currentSpaceId))) ? (
                  <Link
                    to={packageDetailPath(type, pkg.id)}
                    className="font-medium hover:underline"
                  >
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
