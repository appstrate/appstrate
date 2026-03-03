import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download, Package, Store, RefreshCw, Upload } from "lucide-react";
import { useMarketplaceStatus, useMarketplaceSearch } from "../hooks/use-marketplace";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";

const TYPES = ["", "flow", "skill", "extension"] as const;
const PER_PAGE = 12;

export function MarketplacePage() {
  const { t } = useTranslation(["settings", "common"]);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);

  const { data: status, isLoading: statusLoading } = useMarketplaceStatus();
  const { data: results, isLoading: searchLoading } = useMarketplaceSearch(
    { q, type: type || undefined, page, perPage: PER_PAGE },
    !!status?.configured,
  );

  if (statusLoading) {
    return (
      <div className="marketplace-page">
        <LoadingState />
      </div>
    );
  }

  if (!status?.configured) {
    return (
      <div className="marketplace-page">
        <div className="page-header">
          <h2>{t("marketplace.title")}</h2>
        </div>
        <EmptyState
          icon={Store}
          message={t("marketplace.notConfigured")}
          hint={t("marketplace.notConfiguredHint")}
        />
      </div>
    );
  }

  const totalPages = results ? Math.ceil(results.total / PER_PAGE) : 0;

  return (
    <div className="marketplace-page">
      <div className="page-header">
        <h2>{t("marketplace.title")}</h2>
        <div className="page-header-actions">
          <Link to="/marketplace/installed" className="btn-sm">
            <Package size={14} />
            {t("marketplace.navInstalled")}
          </Link>
          <Link to="/marketplace/updates" className="btn-sm">
            <RefreshCw size={14} />
            {t("marketplace.navUpdates")}
          </Link>
          <Link to="/marketplace/publish" className="btn-sm">
            <Upload size={14} />
            {t("marketplace.navPublish")}
          </Link>
        </div>
      </div>

      <div className="marketplace-header">
        <input
          type="text"
          placeholder={t("marketplace.searchPlaceholder")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="marketplace-search"
        />
      </div>

      <div className="marketplace-filters">
        {TYPES.map((filterType) => (
          <button
            key={filterType}
            className={`tab${type === filterType ? " active" : ""}`}
            onClick={() => {
              setType(filterType);
              setPage(1);
            }}
          >
            {filterType === ""
              ? t("marketplace.filterAll")
              : t(`marketplace.filterType.${filterType}`)}
          </button>
        ))}
      </div>

      {searchLoading ? (
        <div className="empty-state">
          <Spinner />
        </div>
      ) : !results || results.packages.length === 0 ? (
        <EmptyState
          icon={Package}
          message={t("marketplace.noResults")}
          hint={q ? t("marketplace.noResultsHint") : undefined}
        />
      ) : (
        <>
          <div className="marketplace-grid">
            {results.packages.map((pkg) => (
              <Link
                key={pkg.id}
                to={`/marketplace/${pkg.scope}/${pkg.name}`}
                className="marketplace-card"
              >
                <div className="marketplace-card-header">
                  <span className="marketplace-card-name">
                    {pkg.scope}/{pkg.name}
                  </span>
                  <TypeBadge type={pkg.type} />
                </div>
                <p className="marketplace-card-desc">
                  {pkg.description || t("marketplace.noDescription")}
                </p>
                <div className="marketplace-card-meta">
                  <span className="marketplace-card-stat">
                    <Download size={12} />
                    {pkg.downloads.toLocaleString()}
                  </span>
                  {pkg.latestVersion && (
                    <span className="marketplace-card-stat">v{pkg.latestVersion}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="marketplace-pagination">
              <button className="btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t("marketplace.prevPage")}
              </button>
              <span className="marketplace-pagination-label">
                {t("marketplace.pageInfo", { page, total: totalPages })}
              </span>
              <button
                className="btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("marketplace.nextPage")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
