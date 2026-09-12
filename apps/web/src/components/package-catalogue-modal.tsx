// SPDX-License-Identifier: Apache-2.0

/**
 * The organisation's catalogue for one package type: what it owns that is NOT
 * active in this space, with one action per row to activate it.
 *
 * One rule for every type, which is what was missing: a LIST says what works
 * in this space, a CATALOGUE says what the organisation has besides. The
 * integrations already worked that way; agents, skills and MCP servers do now.
 * Without it, the skill list showed packages an agent of this space could not
 * use, and said nothing about it.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PackageSearch } from "lucide-react";
import { getErrorMessage } from "@appstrate/core/errors";
import { Input } from "@appstrate/ui/components/input";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useTogglePackageInstall } from "../hooks/use-library";
import { usePackageList, type PackageType } from "../hooks/use-packages";
import type { CardItem } from "../pages/package-list";
import { DataTable } from "./data-table";
import { Modal } from "./modal";
import { usePackageCatalogueColumns } from "./package-catalogue-columns";
import { EmptyState, ErrorState } from "./page-states";

export function PackageCatalogueModal({
  type,
  onClose,
}: {
  type: PackageType;
  onClose: () => void;
}) {
  const { t } = useTranslation(["settings", "agents", "common"]);
  const spaceId = useCurrentSpaceId();
  // The org's whole shelf, and what already sits on this space's bench.
  const { data: all, isLoading, error } = usePackageList(type);
  const { data: active } = usePackageList(type, { activeOnly: true });
  const activate = useTogglePackageInstall();
  const [search, setSearch] = useState("");

  const activeIds = new Set((active ?? []).map((item) => item.id));
  const query = search.trim().toLowerCase();
  const offered: CardItem[] = (all ?? [])
    .filter((item) => !activeIds.has(item.id))
    .filter(
      (item) =>
        !query ||
        `${item.name ?? ""} ${item.description ?? ""} ${item.id}`.toLowerCase().includes(query),
    )
    .map((item) => ({
      id: item.id,
      displayName: item.name || item.id,
      description: item.description,
      type,
      source: item.source,
      usedByAgents: item.used_by_agents,
    }));

  const columns = usePackageCatalogueColumns({
    type,
    isActivating: activate.isPending,
    onActivate: (item) => {
      if (!spaceId) return;
      activate.mutate(
        { spaceId, packageId: item.id, installed: false },
        {
          onSuccess: () => toast.success(t("packages.installed", { name: item.displayName })),
          onError: (err) => toast.error(getErrorMessage(err)),
        },
      );
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t("catalogue.title")}
      className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-3xl"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("catalogue.intro")}</p>
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("catalogue.search")}
          aria-label={t("catalogue.search")}
        />
        <div className="min-h-0 overflow-y-auto">
          <DataTable
            label={t("catalogue.title")}
            columns={columns}
            rows={offered}
            rowKey={(item) => item.id}
            isLoading={isLoading}
            isError={Boolean(error)}
            error={<ErrorState message={getErrorMessage(error)} compact />}
            empty={
              <EmptyState
                message={t("catalogue.empty")}
                hint={t("catalogue.emptyHint")}
                icon={PackageSearch}
                compact
              />
            }
          />
        </div>
      </div>
    </Modal>
  );
}
