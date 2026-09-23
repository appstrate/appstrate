// SPDX-License-Identifier: Apache-2.0

/**
 * "Partages en attente": every decision a colleague's share left waiting, one
 * list across kinds.
 *
 * With one share, every link goes straight to that package's sheet. With
 * several, the reader needs them side by side — and before this list they were
 * scattered across the kind tabs, where a skill waiting behind an agent was
 * found by nobody. Each row is ONE decision (a package, one space) with its
 * deed on the line; activating it removes the row, because this is a queue of
 * decisions, not a history.
 */
import { useTranslation } from "react-i18next";
import { Inbox } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@appstrate/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import type { LibraryPackageItem } from "../hooks/use-library";
import type { PendingShare } from "../lib/catalogue-placement";
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
  // Spelled out, so the locale test sees every key it declares used.
  const typeLabel: Record<PackageType, string> = {
    agent: t("catalogue.sheet.type.agent"),
    skill: t("catalogue.sheet.type.skill"),
    integration: t("catalogue.sheet.type.integration"),
    "mcp-server": t("catalogue.sheet.type.mcp-server"),
  };

  return (
    <div>
      <SettingsHeading
        title={t("catalogue.shared.title")}
        description={t("catalogue.shared.description")}
      />
      {shares.length === 0 ? (
        <EmptyState
          message={t("catalogue.shared.empty")}
          hint={t("catalogue.shared.emptyHint")}
          icon={Inbox}
          compact
        />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("catalogue.shared.item")}</TableHead>
                <TableHead>{t("catalogue.shared.type")}</TableHead>
                <TableHead>{t("catalogue.shared.by")}</TableHead>
                <TableHead>{t("catalogue.shared.with")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("catalogue.shared.action")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shares.map((share) => {
                const space = spaceNameOf(share.spaceId);
                return (
                  <TableRow key={`${share.pkg.id}:${share.spaceId}`}>
                    <TableCell className="max-w-64">
                      {/* The name opens the sheet, for whoever wants to read
                          before deciding. */}
                      <button
                        type="button"
                        className="block max-w-full truncate p-0 text-left font-medium hover:underline"
                        onClick={() => onOpen(share.pkg)}
                      >
                        {share.pkg.name || share.pkg.id}
                      </button>
                      {share.pkg.description && (
                        <span className="text-muted-foreground block truncate text-xs">
                          {share.pkg.description}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {typeLabel[share.pkg.type]}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{share.sharedBy ?? "—"}</TableCell>
                    <TableCell>{space}</TableCell>
                    <TableCell className="text-right">
                      {mayActivateIn(share.pkg, share.spaceId) ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => onActivate(share.pkg, share.spaceId)}
                        >
                          {t("catalogue.sheet.activateIn", { space })}
                        </Button>
                      ) : (
                        // No refused button: the reader is told who can act.
                        <span className="text-muted-foreground text-xs">
                          {t("catalogue.shared.noRight", { space })}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
