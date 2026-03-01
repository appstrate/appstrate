import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useMarketplaceUpdates, useUpdatePackage } from "../hooks/use-marketplace";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";

export function MarketplaceUpdatesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data, isLoading, refetch, isFetching } = useMarketplaceUpdates();
  const update = useUpdatePackage();

  if (isLoading) {
    return (
      <div className="marketplace-page">
        <LoadingState />
      </div>
    );
  }

  const updates = data?.updates ?? [];

  return (
    <div className="marketplace-page">
      <Link to="/marketplace" className="breadcrumb">
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="page-header">
        <h2>{t("marketplace.updatesTitle")}</h2>
        <button className="btn-sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Spinner /> : <RefreshCw size={14} />}
          {t("marketplace.checkUpdates")}
        </button>
      </div>

      {updates.length === 0 ? (
        <EmptyState message={t("marketplace.upToDate")} />
      ) : (
        <div className="library-table-wrap">
          <table className="library-table">
            <thead>
              <tr>
                <th>{t("marketplace.colPackage")}</th>
                <th>{t("marketplace.colType")}</th>
                <th>{t("marketplace.colInstalled")}</th>
                <th>{t("marketplace.colLatest")}</th>
                <th>{t("marketplace.colStatus")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {updates.map((pkg) => (
                <tr key={pkg.id}>
                  <td>
                    <Link to={`/marketplace/@${pkg.registryScope}/${pkg.registryName}`}>
                      {pkg.displayName || `${pkg.registryScope}/${pkg.registryName}`}
                    </Link>
                  </td>
                  <td>
                    <TypeBadge type={pkg.type as "flow" | "skill" | "extension"} />
                  </td>
                  <td>v{pkg.installedVersion}</td>
                  <td>{pkg.latestVersion ? `v${pkg.latestVersion}` : "-"}</td>
                  <td>
                    {pkg.updateAvailable ? (
                      <span className="marketplace-update-badge">
                        {t("marketplace.updateAvailableBadge")}
                      </span>
                    ) : (
                      <span className="marketplace-uptodate">{t("marketplace.upToDate")}</span>
                    )}
                  </td>
                  <td>
                    {pkg.updateAvailable && (
                      <button
                        className="btn-sm"
                        onClick={() =>
                          update.mutate(
                            { scope: `@${pkg.registryScope}`, name: pkg.registryName },
                            {
                              onError: (err) => alert(t("error.prefix", { message: err.message })),
                            },
                          )
                        }
                        disabled={update.isPending}
                      >
                        {update.isPending ? <Spinner /> : t("marketplace.update")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
