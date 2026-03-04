import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Package } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "../hooks/use-org";
import { marketplacePath } from "../lib/strings";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";

interface InstalledPackage {
  id: string;
  type: "flow" | "skill" | "extension";
  manifest: { version?: string; name?: string; description?: string } | null;
  updatedAt: string;
  registryScope: string | null;
  registryName: string | null;
}

function useInstalledPackages() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["marketplace", "installed", orgId],
    queryFn: () =>
      api<{ packages: InstalledPackage[] }>("/marketplace/installed").then((r) => r.packages),
  });
}

export function MarketplaceInstalledPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: packages, isLoading } = useInstalledPackages();

  if (isLoading) {
    return (
      <div className="marketplace-page">
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="marketplace-page">
      <Link to="/marketplace" className="breadcrumb">
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="page-header">
        <h2>{t("marketplace.installedTitle")}</h2>
      </div>

      {!packages || packages.length === 0 ? (
        <EmptyState icon={Package} message={t("marketplace.installedEmpty")} />
      ) : (
        <div className="marketplace-grid">
          {packages.map((pkg) => {
            const version = pkg.manifest?.version;
            const displayName = pkg.manifest?.name || pkg.id;
            const path = marketplacePath({ id: pkg.id });

            return (
              <div key={pkg.id} className="marketplace-card">
                <div className="marketplace-card-header">
                  <span className="marketplace-card-name">{displayName}</span>
                  <TypeBadge type={pkg.type} />
                </div>
                <p className="marketplace-card-desc">{pkg.manifest?.description || pkg.id}</p>
                <div className="marketplace-card-meta">
                  {version && <span className="marketplace-card-stat">v{version}</span>}
                  {path && (
                    <Link to={path} className="marketplace-card-stat marketplace-detail-link">
                      {t("packages.viewOnMarketplace")}
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
