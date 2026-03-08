import { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Download, Package, Store, RefreshCw, Upload, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMarketplaceStatus, useMarketplaceSearch } from "../hooks/use-marketplace";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabWithHash } from "../hooks/use-tab-with-hash";

const TYPES = ["", "flow", "skill", "extension", "provider"] as const;
type MarketplaceTab = (typeof TYPES)[number];
const PER_PAGE = 12;

export function MarketplacePage() {
  const { t } = useTranslation(["settings", "common"]);
  const [q, setQ] = useState("");
  const [type, setType] = useTabWithHash<MarketplaceTab>(TYPES, "");
  const [page, setPage] = useState(1);

  const { data: status, isLoading: statusLoading } = useMarketplaceStatus();
  const { data: results, isLoading: searchLoading } = useMarketplaceSearch(
    { q, type: type || undefined, page, perPage: PER_PAGE },
    !!status?.configured,
  );

  if (statusLoading) {
    return (
      <div className="max-w-[900px]">
        <LoadingState />
      </div>
    );
  }

  if (!status?.configured) {
    return (
      <div className="max-w-[900px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t("marketplace.title")}</h2>
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
    <div className="max-w-[900px]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t("marketplace.title")}</h2>
        <div className="flex items-center gap-2">
          <Link
            to="/marketplace/updates"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors no-underline"
          >
            <RefreshCw size={14} />
            {t("marketplace.navUpdates")}
          </Link>
          <Link
            to="/marketplace/publish"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors no-underline"
          >
            <Upload size={14} />
            {t("marketplace.navPublish")}
          </Link>
          <Link
            to="/marketplace/connection"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors no-underline"
          >
            <Plug size={14} />
            {t("marketplace.navConnection")}
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 mb-4">
        <Input
          type="text"
          placeholder={t("marketplace.searchPlaceholder")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          className="flex-1"
        />
      </div>

      <Tabs
        value={type}
        onValueChange={(v) => {
          setType(v as MarketplaceTab);
          setPage(1);
        }}
      >
        <TabsList className="mb-4">
          {TYPES.map((filterType) => (
            <TabsTrigger key={filterType} value={filterType}>
              {filterType === ""
                ? t("marketplace.filterAll")
                : t(`marketplace.filterType.${filterType}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {searchLoading ? (
        <div className="flex items-center justify-center py-8">
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
          <div className="grid grid-cols-1 gap-3">
            {results.packages.map((pkg) => (
              <Link
                key={pkg.id}
                to={`/marketplace/${pkg.scope}/${pkg.name}`}
                className="block rounded-lg border border-border bg-card px-4 py-3.5 no-underline text-inherit transition-colors hover:border-primary hover:bg-muted/50"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="font-semibold text-sm">
                    {pkg.scope}/{pkg.name}
                  </span>
                  <TypeBadge type={pkg.type} />
                </div>
                <p className="text-muted-foreground text-xs mb-2 line-clamp-2">
                  {pkg.description || t("marketplace.noDescription")}
                </p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Download size={12} />
                    {pkg.downloads.toLocaleString()}
                  </span>
                  {pkg.latestVersion && (
                    <span className="inline-flex items-center gap-1">v{pkg.latestVersion}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-2 mt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                {t("marketplace.prevPage")}
              </Button>
              <span className="text-xs text-muted-foreground flex items-center">
                {t("marketplace.pageInfo", { page, total: totalPages })}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("marketplace.nextPage")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
