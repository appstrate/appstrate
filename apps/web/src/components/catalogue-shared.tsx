// SPDX-License-Identifier: Apache-2.0

/**
 * "Partages en attente": every decision a colleague's share leaves waiting, one
 * list across kinds.
 *
 * With one share, every link goes straight to that package's sheet. With
 * several, the reader needs them side by side rather than scattered across the
 * kind tabs, where a skill waiting behind an agent is found by nobody. Each row
 * is ONE decision (a package, one space) with its deed on the line; activating
 * it removes the row, because this is a queue of decisions, not a history.
 */
import { useTranslation } from "react-i18next";
import { Inbox } from "lucide-react";
import type { LibraryPackageItem } from "../hooks/use-library";
import type { PendingShare } from "../lib/catalogue-placement";
import { useCatalogueSharedColumns } from "./catalogue-shared-columns";
import { DataTable } from "./data-table";
import { EmptyState } from "./page-states";
import { SettingsHeading } from "./settings/settings-heading";

export function CatalogueShared({
  shares,
  spaceNameOf,
  mayActivateIn,
  busy,
  onActivate,
  onOpen,
}: {
  shares: PendingShare[];
  spaceNameOf: (spaceId: string) => string;
  /** The reader's verdict for switching this package on in that space. */
  mayActivateIn: (pkg: LibraryPackageItem, spaceId: string) => boolean;
  busy: boolean;
  onActivate: (pkg: LibraryPackageItem, spaceId: string) => void;
  onOpen: (pkg: LibraryPackageItem) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const columns = useCatalogueSharedColumns({ spaceNameOf, mayActivateIn, busy, onActivate });

  return (
    <div>
      <SettingsHeading
        title={t("catalogue.shared.title")}
        description={t("catalogue.shared.description")}
      />
      <DataTable
        tableId="catalogue-shares"
        tiered
        label={t("catalogue.shared.title")}
        columns={columns}
        rows={shares}
        rowKey={(share) => `${share.pkg.id}:${share.spaceId}`}
        rowAction={(share) => onOpen(share.pkg)}
        rowLabel={(share) => share.pkg.name || share.pkg.id}
        empty={
          <EmptyState
            message={t("catalogue.shared.empty")}
            hint={t("catalogue.shared.emptyHint")}
            icon={Inbox}
            compact
          />
        }
      />
    </div>
  );
}
