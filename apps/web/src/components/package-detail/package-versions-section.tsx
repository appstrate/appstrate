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
import { DiffTab } from "../diff-tab";
import { Modal } from "../modal";
import { LoadingState } from "../page-states";
import { VersionHistory } from "../version-history";

type LatestVersion = Parameters<typeof DiffTab>[0]["latestVersion"];

export function PackageVersionsSection({
  type,
  packageId,
  canRestore,
  canDelete,
  latestVersion,
  currentManifest,
  currentContent,
  hasUnarchivedChanges,
}: {
  type: PackageType;
  packageId: string;
  canRestore: boolean;
  canDelete: boolean;
  latestVersion?: LatestVersion;
  currentManifest?: Record<string, unknown>;
  currentContent?: string | null;
  hasUnarchivedChanges?: boolean;
}) {
  const { t } = useTranslation("agents");
  // `?compare=<version>`: the comparison with the draft has an address.
  const compareParam = useModalParam("compare");
  const compare = compareParam.value;
  // The latest version is already loaded by the page; any other row is fetched
  // when its comparison is asked for.
  const picked = compare && compare !== latestVersion?.version ? compare : undefined;
  const { data: pickedDetail } = useVersionDetail(type, packageId, picked);
  const compared =
    compare === null ? null : picked ? (pickedDetail ?? null) : (latestVersion ?? null);

  return (
    <div className="space-y-4 p-6">
      {hasUnarchivedChanges && latestVersion && (
        <div className="border-border flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
          <p className="text-muted-foreground min-w-0 flex-1 text-sm">{t("version.draftAhead")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => compareParam.open(latestVersion.version)}
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
        onCompare={(version) => compareParam.open(version)}
      />

      <Modal
        open={compare !== null}
        onClose={compareParam.close}
        title={t("detail.files.compareTitle", { version: compare })}
        className="max-w-5xl"
      >
        {compared ? (
          <DiffTab
            type={type}
            latestVersion={compared}
            currentManifest={currentManifest}
            currentContent={currentContent}
          />
        ) : (
          <LoadingState />
        )}
      </Modal>
    </div>
  );
}
