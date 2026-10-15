// SPDX-License-Identifier: Apache-2.0

/**
 * A package's versions, as a section of Paramètres › Explorer — for every type.
 *
 * Browsing the history is exploring the package, the way its map and its files
 * are, so it sits beside them rather than in a top-level tab of its own.
 *
 * The section is the history. A draft holding changes that are in no version
 * yet says so in one line above the list, with the comparison one click away,
 * and any row can be compared to the draft from its own menu: the diff is a
 * gesture on the list, not a block that pushes it off the screen.
 */
import { useTranslation } from "react-i18next";
import { GitCompareArrows } from "lucide-react";
import type { PackageType } from "@appstrate/core/validation";
import { Button } from "@appstrate/ui/components/button";
import { useModalParam } from "../../hooks/use-modal-param";
import { useVersionDetail } from "../../hooks/use-packages";
import { VersionHistory } from "../version-history";
import { CompareWithDraftModal } from "./compare-with-draft-modal";

export function PackageVersionsSection({
  type,
  packageId,
  canRestore,
  canDelete,
  onCreate,
  hasUnarchivedChanges,
}: {
  type: PackageType;
  packageId: string;
  canRestore: boolean;
  canDelete: boolean;
  onCreate?: () => void;
  hasUnarchivedChanges?: boolean;
}) {
  const { t } = useTranslation("agents");
  // `?compare=<version>`: the comparison with the draft has an address.
  const compare = useModalParam("compare");
  const { data: latestVersion } = useVersionDetail(
    type,
    packageId,
    hasUnarchivedChanges ? "latest" : undefined,
  );

  return (
    <div className="space-y-4 p-6">
      {hasUnarchivedChanges && latestVersion && (
        <div className="border-border flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
          <p className="text-muted-foreground min-w-0 flex-1 text-sm">{t("version.draftAhead")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => compare.open(latestVersion.version)}
          >
            <GitCompareArrows />
            {t("version.compare")}
          </Button>
        </div>
      )}
      <VersionHistory
        packageId={packageId}
        type={type}
        canRestore={canRestore}
        canDelete={canDelete}
        onCreate={onCreate}
        onCompare={(version) => compare.open(version)}
      />
      <CompareWithDraftModal
        type={type}
        packageId={packageId}
        compare={compare}
        latestVersion={latestVersion}
      />
    </div>
  );
}
