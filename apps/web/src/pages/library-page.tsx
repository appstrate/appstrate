// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Package } from "lucide-react";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { useLibrary, useTogglePackageInstall } from "../hooks/use-library";
import type { LibraryPackageItem, LibraryApp } from "../hooks/use-library";
import { useTabWithHash } from "../hooks/use-tab-with-hash";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

const TABS = ["agents", "skills", "tools", "providers"] as const;
type Tab = (typeof TABS)[number];

const TYPE_MAP: Record<Tab, string> = {
  agents: "agent",
  skills: "skill",
  tools: "tool",
  providers: "provider",
};

const DETAIL_PATH_MAP: Record<string, string> = {
  agent: "/agents",
  skill: "/skills",
  tool: "/tools",
  provider: "/providers",
};

export function LibraryPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useLibrary();
  const [activeTab, setActiveTab] = useTabWithHash(TABS, "agents");

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;
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
              applications={data.applications}
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
  applications,
  type,
}: {
  packages: LibraryPackageItem[];
  applications: LibraryApp[];
  type: string;
}) {
  const { t } = useTranslation();
  const toggle = useTogglePackageInstall();

  if (pkgs.length === 0) {
    return <EmptyState message={t("library.empty")} icon={Package} />;
  }

  const handleToggle = (pkg: LibraryPackageItem, appId: string, installed: boolean) => {
    if (pkg.source === "system") return;
    toggle.mutate(
      { appId, packageId: pkg.id, installed },
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
          {applications.map((app) => (
            <TableHead key={app.id} className="text-center">
              <span className="text-xs">{app.name}</span>
              {app.isDefault && (
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
            {applications.map((app) => {
              const installed = pkg.installedIn.includes(app.id);
              const isSystem = pkg.source === "system";
              return (
                <TableCell key={app.id} className="text-center">
                  <Checkbox
                    checked={isSystem || installed}
                    disabled={isSystem}
                    title={isSystem ? t("library.systemAlwaysActive") : undefined}
                    onCheckedChange={() => handleToggle(pkg, app.id, installed)}
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
