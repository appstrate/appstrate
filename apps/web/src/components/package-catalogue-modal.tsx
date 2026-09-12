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
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useTogglePackageInstall } from "../hooks/use-library";
import { usePackageList, type PackageType } from "../hooks/use-packages";
import { ItemList } from "./item-list";
import { Modal } from "./modal";
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
  const offered = (all ?? [])
    .filter((item) => !activeIds.has(item.id))
    .filter(
      (item) =>
        !query ||
        `${item.name ?? ""} ${item.description ?? ""} ${item.id}`.toLowerCase().includes(query),
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={t("catalogue.title")}
      className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl"
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
          <ItemList
            items={offered}
            itemKey={(item) => item.id}
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
            renderItem={(item) => (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{item.name || item.id}</span>
                    {item.source === "system" && (
                      <Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
                        {t("library.system")}
                      </Badge>
                    )}
                  </div>
                  {item.description && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                      {item.description}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!spaceId || activate.isPending}
                  onClick={() => {
                    if (!spaceId) return;
                    activate.mutate(
                      { spaceId, packageId: item.id, installed: false },
                      {
                        onSuccess: () =>
                          toast.success(t("packages.installed", { name: item.name || item.id })),
                        onError: (err) => toast.error(getErrorMessage(err)),
                      },
                    );
                  }}
                >
                  {t("catalogue.activate")}
                </Button>
              </div>
            )}
          />
        </div>
      </div>
    </Modal>
  );
}
