// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Package, Download, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePackageList } from "../hooks/use-packages";
import {
  useInstalledPackages,
  useInstallPackage,
  useUninstallPackage,
} from "../hooks/use-installed-packages";
import { PageHeader } from "../components/page-header";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { ImportModal } from "../components/import-modal";
import { usePermissions } from "../hooks/use-permissions";

export function CatalogPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { isAdmin } = usePermissions();
  const [importOpen, setImportOpen] = useState(false);

  const { data: agents, isLoading, error } = usePackageList("agent");
  const { data: installedPackages } = useInstalledPackages("agent");
  const installMutation = useInstallPackage();
  const uninstallMutation = useUninstallPackage();

  const installedIds = new Set(installedPackages?.map((p) => p.packageId) ?? []);

  function handleInstall(packageId: string) {
    installMutation.mutate(
      { packageId },
      {
        onSuccess: () => toast.success(t("common:toast.success")),
        onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
      },
    );
  }

  function handleUninstall(packageId: string) {
    uninstallMutation.mutate(packageId, {
      onSuccess: () => toast.success(t("common:toast.success")),
      onError: (err) => toast.error(err instanceof Error ? err.message : String(err)),
    });
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  return (
    <>
      <PageHeader
        title={t("common:nav.catalog", { defaultValue: "Catalogue" })}
        emoji="📦"
        breadcrumbs={[
          { label: t("common:nav.orgSection"), href: "/" },
          { label: t("common:nav.catalog", { defaultValue: "Catalogue" }) },
        ]}
        actions={
          isAdmin ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                {t("common:nav.import")}
              </Button>
              <Link to="/agents/new">
                <Button>{t("agents:list.create")}</Button>
              </Link>
            </>
          ) : undefined
        }
      />

      {!agents || agents.length === 0 ? (
        <EmptyState
          message={t("common:nav.catalogEmpty", {
            defaultValue: "Aucun package dans le catalogue.",
          })}
          icon={Package}
        >
          {isAdmin && (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              {t("common:nav.import")}
            </Button>
          )}
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {agents.map((pkg) => {
            const isInstalled = installedIds.has(pkg.id);
            const displayName = pkg.name ?? pkg.id.split("/")[1] ?? pkg.id;
            const description = pkg.description;

            return (
              <div
                key={pkg.id}
                className="border-border bg-card flex items-center justify-between rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link to={`/agents/${pkg.id}`} className="truncate font-medium hover:underline">
                      {displayName}
                    </Link>
                    {pkg.source === "system" && (
                      <Badge variant="secondary">{t("agents:list.badgeBuiltIn")}</Badge>
                    )}
                    {isInstalled && <Badge variant="success">Installé</Badge>}
                  </div>
                  {description && (
                    <p className="text-muted-foreground mt-0.5 truncate text-sm">{description}</p>
                  )}
                  <p className="text-muted-foreground mt-0.5 font-mono text-xs">{pkg.id}</p>
                </div>

                {isAdmin && (
                  <div className="ml-4 shrink-0">
                    {isInstalled ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleUninstall(pkg.id)}
                        disabled={uninstallMutation.isPending}
                      >
                        <Trash2 className="mr-1.5 size-3.5" />
                        Désinstaller
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleInstall(pkg.id)}
                        disabled={installMutation.isPending}
                      >
                        <Download className="mr-1.5 size-3.5" />
                        Installer
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}
