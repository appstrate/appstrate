import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CheckCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type ColumnDef } from "../components/data-table";
import {
  useMarketplaceUpdates,
  useUpdatePackage,
  type PackageUpdateStatus,
} from "../hooks/use-marketplace";
import { LoadingState, EmptyState } from "../components/page-states";
import { TypeBadge } from "../components/type-badge";
import { Spinner } from "../components/spinner";

function UpdateAction({ pkg }: { pkg: PackageUpdateStatus }) {
  const { t } = useTranslation(["settings", "common"]);
  const update = useUpdatePackage();

  if (!pkg.updateAvailable) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        update.mutate(
          { scope: pkg.scope, name: pkg.name },
          { onError: (err) => alert(t("error.prefix", { message: err.message })) },
        )
      }
      disabled={update.isPending}
    >
      {update.isPending ? <Spinner /> : t("marketplace.update")}
    </Button>
  );
}

export function MarketplaceUpdatesPage() {
  const { t } = useTranslation(["settings", "common"]);
  const { data, isLoading, refetch, isFetching } = useMarketplaceUpdates();

  const columns = useMemo<ColumnDef<PackageUpdateStatus, unknown>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: t("marketplace.colPackage"),
        cell: ({ row }) => (
          <Link
            to={`/marketplace/${row.original.scope}/${row.original.name}`}
            className="hover:text-primary"
          >
            {row.original.displayName || `${row.original.scope}/${row.original.name}`}
          </Link>
        ),
      },
      {
        accessorKey: "type",
        header: t("marketplace.colType"),
        cell: ({ row }) => <TypeBadge type={row.original.type} />,
      },
      {
        accessorKey: "installedVersion",
        header: t("marketplace.colInstalled"),
        cell: ({ row }) => `v${row.original.installedVersion}`,
      },
      {
        accessorKey: "latestVersion",
        header: t("marketplace.colLatest"),
        cell: ({ row }) => (row.original.latestVersion ? `v${row.original.latestVersion}` : "-"),
      },
      {
        id: "status",
        header: t("marketplace.colStatus"),
        cell: ({ row }) =>
          row.original.updateAvailable ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-warning">
              {t("marketplace.updateAvailableBadge")}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("marketplace.upToDate")}</span>
          ),
      },
      {
        id: "actions",
        cell: ({ row }) => <UpdateAction pkg={row.original} />,
      },
    ],
    [t],
  );

  if (isLoading) {
    return (
      <div className="max-w-[900px]">
        <LoadingState />
      </div>
    );
  }

  const updates = data?.updates ?? [];

  return (
    <div className="max-w-[900px]">
      <Link
        to="/marketplace"
        className="flex items-center gap-1.5 text-sm text-muted-foreground mb-4 hover:text-foreground"
      >
        <ArrowLeft size={14} />
        <span>{t("marketplace.backToMarketplace")}</span>
      </Link>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t("marketplace.updatesTitle")}</h2>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Spinner /> : <RefreshCw size={14} />}
          {t("marketplace.checkUpdates")}
        </Button>
      </div>

      {updates.length === 0 ? (
        <EmptyState message={t("marketplace.upToDate")} icon={CheckCircle} />
      ) : (
        <DataTable columns={columns} data={updates} />
      )}
    </div>
  );
}
