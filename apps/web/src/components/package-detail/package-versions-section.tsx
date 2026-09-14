// SPDX-License-Identifier: Apache-2.0

/**
 * A package's versions, as a section of Paramètres › Explorer — for every type.
 *
 * Browsing the history is exploring the package, the way its map and its files
 * are, so it sits beside them rather than in a top-level tab of its own. The
 * draft's unarchived changes against the latest version, which used to be a
 * second tab ("Modifications"), are the head of that same history.
 */
import { useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { DiffTab } from "../diff-tab";
import { VersionHistory } from "../version-history";
import { SettingsHeading } from "../settings/settings-heading";

type LatestVersion = Parameters<typeof DiffTab>[0]["latestVersion"];

export function PackageVersionsSection({
  type,
  packageId,
  isOwned,
  latestVersion,
  currentManifest,
  currentContent,
  hasUnarchivedChanges,
}: {
  type: PackageType;
  packageId: string;
  isOwned: boolean;
  latestVersion?: LatestVersion;
  currentManifest?: Record<string, unknown>;
  currentContent?: string | null;
  hasUnarchivedChanges?: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="space-y-8 p-6">
      {hasUnarchivedChanges && latestVersion && (
        <section>
          <SettingsHeading level="group" title={t("version.diff")} />
          <DiffTab
            type={type}
            latestVersion={latestVersion}
            currentManifest={currentManifest}
            currentContent={currentContent}
          />
        </section>
      )}
      <section>
        <SettingsHeading level="group" title={t("version.archives")} />
        <VersionHistory packageId={packageId} type={type} isOwned={isOwned} />
      </section>
    </div>
  );
}
