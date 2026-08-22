// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Package } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useLibrary, useTogglePackageInstall } from "../hooks/use-library";
import { collectionVerdict } from "../components/collection";
import type { LibraryPackageItem, LibraryApp } from "../hooks/use-library";
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

/**
 * The head band, taken from `DataTable` rather than left to shadcn's default.
 * The matrix cannot BE a data table, but it sits two tabs away from three that
 * are, and a column head in sentence case beside three in small caps reads as
 * an oversight.
 */
const HEAD =
  "text-muted-foreground min-w-[160px] text-[0.68rem] font-semibold tracking-[0.05em] uppercase";

const DETAIL_PATH_MAP: Record<string, string> = {
  agent: "/agents",
  skill: "/skills",
  integration: "/integrations",
};

export function LibraryPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useLibrary();
  const [activeTab, setActiveTab] = useTabWithHash(TABS, "agents");

  return (
    <div>
      <PageHeader title={t("library.title")} />
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
        <TabsList>
          {TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`library.tab.${tab}`)}
              <span className="text-muted-foreground ml-1.5 text-xs">
                {data?.packages[TYPE_MAP[tab]]?.length ?? 0}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((tab) => (
          <TabsContent key={tab} value={tab}>
            <LibraryMatrix
              packages={data?.packages[TYPE_MAP[tab]] ?? []}
              applications={data?.applications ?? []}
              type={TYPE_MAP[tab]}
              isLoading={isLoading}
              isError={Boolean(error)}
              errorMessage={getErrorMessage(error)}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

/**
 * Packages down, workspaces across, a checkbox at every crossing.
 *
 * It is NOT a fourth collection, and the migration stopped here on purpose.
 * `DataTable`'s contract is one table with many column SETS, where a column is
 * an attribute of the row and can therefore be dropped when the width runs
 * out. Here a column is another ENTITY: dropping a workspace does not hide an
 * attribute, it hides the checkbox that is the only way to install into it. And
 * the arithmetic agrees — three workspaces already come to 452px of floors
 * against a phone's 390, with nothing that may be given up.
 *
 * A matrix scrolls where a list degrades, which is exactly what shadcn's own
 * `Table` does (`overflow-auto` on its wrapper) and what `DataTable` cannot
 * (`overflow-hidden`, for the frame's radius). So it keeps the raw table and
 * takes the rest of the family: the same frame, the same states, drawn in
 * place rather than above the tabs.
 */
function LibraryMatrix({
  packages: pkgs,
  applications,
  type,
  isLoading,
  isError,
  errorMessage,
}: {
  packages: LibraryPackageItem[];
  applications: LibraryApp[];
  type: string;
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
}) {
  const { t } = useTranslation();
  const toggle = useTogglePackageInstall();
  // Agents/skills treat a "system" package as globally available (locked on,
  // can't toggle). Integrations are different: they must be activated per
  // application even when system-sourced, so their system rows stay toggleable.
  const lockSystem = type !== "integration";

  const handleToggle = (pkg: LibraryPackageItem, applicationId: string, installed: boolean) => {
    if (lockSystem && pkg.source === "system") return;
    toggle.mutate(
      { applicationId, packageId: pkg.id, installed },
      {
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : t("error.generic"));
        },
      },
    );
  };

  const basePath = DETAIL_PATH_MAP[type] ?? "/agents";

  // Failure, then loading, then emptiness — `collection.ts` owns that order,
  // and a matrix answers it like every other body even though it is not one.
  const verdict = collectionVerdict({ isLoading, isError, empty: true }, pkgs.length);
  if (verdict !== "items") {
    return (
      <Frame>
        {verdict === "error" ? (
          <ErrorState message={errorMessage} compact />
        ) : verdict === "loading" ? (
          <LoadingState />
        ) : (
          <EmptyState message={t("library.empty")} icon={Package} compact />
        )}
      </Frame>
    );
  }

  return (
    <Frame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={HEAD}>{t("library.column.package")}</TableHead>
            {applications.map((app) => (
              <TableHead key={app.id} className={`${HEAD} text-center`}>
                <span>{app.name}</span>
                {app.isDefault && (
                  <Badge variant="outline" className="ml-1 px-1 py-0 text-[0.6rem] normal-case">
                    {t("library.defaultApp")}
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
              {applications.map((app) => {
                const installed = pkg.installed_in.includes(app.id);
                const locked = lockSystem && pkg.source === "system";
                return (
                  <TableCell key={app.id} className="text-center">
                    <Checkbox
                      checked={locked || installed}
                      disabled={locked}
                      title={locked ? t("library.systemAlwaysActive") : undefined}
                      onCheckedChange={() => handleToggle(pkg, app.id, installed)}
                    />
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  );
}

/** The frame every collection body wears, matrix included. */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="bg-card overflow-hidden rounded-lg border shadow-sm">{children}</div>;
}
