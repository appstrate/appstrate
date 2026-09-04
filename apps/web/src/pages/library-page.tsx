// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Package } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useLibrary, useTogglePackageInstall } from "../hooks/use-library";
import type { LibraryPackageItem, LibrarySpace } from "../hooks/use-library";
import { usePermissions, type GateablePermission } from "../hooks/use-permissions";
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

const TABS = ["agents", "skills", "integrations"] as const;
type Tab = (typeof TABS)[number];

const TYPE_MAP: Record<Tab, "agent" | "skill" | "integration"> = {
  agents: "agent",
  skills: "skill",
  integrations: "integration",
};

const DETAIL_PATH_MAP: Record<string, string> = {
  agent: "/agents",
  skill: "/skills",
  integration: "/integrations",
};

/**
 * Permission that opens the install checkbox, per package type — the same
 * table the API enforces (`SPACE_PACKAGE_PERMISSION`, `routes/spaces.ts`).
 * `agents:configure` rather than `agents:write`: installing configures which
 * space runs an agent, it does not author one.
 */
const INSTALL_PERMISSION_BY_TYPE: Record<string, GateablePermission> = {
  agent: "agents:configure",
  skill: "skills:write",
  "mcp-server": "mcp-servers:write",
  integration: "integrations:install",
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
  type: string;
}) {
  const { t } = useTranslation();
  const { can } = usePermissions();
  const toggle = useTogglePackageInstall();
  // Installing into a space is `POST /api/spaces/:spaceId/packages`, guarded
  // by the SPACE-level string for the package TYPE — not by `spaces:write`,
  // which is the org-level catalog verb and would hide the checkboxes from
  // every space admin. One gate per tab is still correct on this cross-space
  // grid: a tab shows one type, and `can` reads the current space's set.
  const canInstall = can(INSTALL_PERMISSION_BY_TYPE[type] ?? "agents:configure");
  // Agents/skills treat a "system" package as globally available (locked on,
  // can't toggle). Integrations are different: they must be activated per
  // space even when system-sourced, so their system rows stay toggleable.
  const lockSystem = type !== "integration";

  if (pkgs.length === 0) {
    return <EmptyState message={t("library.empty")} icon={Package} />;
  }

  const handleToggle = (pkg: LibraryPackageItem, spaceId: string, installed: boolean) => {
    if (lockSystem && pkg.source === "system") return;
    if (!canInstall) return;
    toggle.mutate(
      { spaceId, packageId: pkg.id, installed },
      {
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("error.generic"));
        },
      },
    );
  };

  const basePath = DETAIL_PATH_MAP[type] ?? "/agents";

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
                <Link to={`${basePath}/${pkg.id}`} className="font-medium hover:underline">
                  {pkg.name}
                </Link>
                {pkg.source === "system" && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[0.6rem]">
                    {t("library.system")}
                  </Badge>
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
              const locked = (lockSystem && pkg.source === "system") || !canInstall;
              return (
                <TableCell key={space.id} className="text-center">
                  <Checkbox
                    checked={locked || installed}
                    disabled={locked}
                    title={locked ? t("library.systemAlwaysActive") : undefined}
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
