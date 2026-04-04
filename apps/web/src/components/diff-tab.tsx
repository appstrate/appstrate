// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { PackageType } from "@appstrate/core/validation";
import type { VersionDetailResponse } from "@appstrate/shared-types";
import { DraftDiffView } from "./draft-diff-view";

interface DiffTabProps {
  type: PackageType;
  latestVersion: VersionDetailResponse;
  currentManifest: Record<string, unknown> | undefined;
  currentContent: string | undefined | null;
}

export function DiffTab({ type, latestVersion, currentManifest, currentContent }: DiffTabProps) {
  const { t } = useTranslation("agents");

  const hasManifestChanges =
    JSON.stringify(currentManifest ?? {}) !== JSON.stringify(latestVersion.manifest ?? {});
  const hasContentChanges =
    latestVersion.content != null &&
    currentContent != null &&
    latestVersion.content !== currentContent;
  const contentLabel = t(`editor.tabContent.${type}`);

  const [subTab, setSubTab] = useState<"manifest" | "content">(
    hasManifestChanges ? "manifest" : "content",
  );

  // Auto-correct if the selected sub-tab has no changes
  const effectiveSubTab = (() => {
    if (subTab === "content" && !hasContentChanges && hasManifestChanges) return "manifest";
    if (subTab === "manifest" && !hasManifestChanges && hasContentChanges) return "content";
    return subTab;
  })();

  if (!hasManifestChanges && !hasContentChanges) {
    return (
      <p className="text-muted-foreground py-4 text-center text-sm">{t("version.noChanges")}</p>
    );
  }

  const versionLabel = `v${latestVersion.version}`;
  const activeLabel = t("version.activeLabel");

  return (
    <>
      <Tabs
        value={effectiveSubTab}
        onValueChange={(v) => setSubTab(v as "manifest" | "content")}
        className="mb-4"
      >
        <TabsList>
          {hasManifestChanges && (
            <TabsTrigger value="manifest">{t("version.diffManifest")}</TabsTrigger>
          )}
          {hasContentChanges && <TabsTrigger value="content">{contentLabel}</TabsTrigger>}
        </TabsList>
      </Tabs>
      {effectiveSubTab === "manifest" && hasManifestChanges && (
        <DraftDiffView
          original={JSON.stringify(latestVersion.manifest ?? {}, null, 2)}
          modified={JSON.stringify(currentManifest ?? {}, null, 2)}
          language="json"
          originalLabel={versionLabel}
          modifiedLabel={activeLabel}
        />
      )}
      {effectiveSubTab === "content" &&
        hasContentChanges &&
        currentContent != null &&
        latestVersion.content != null && (
          <DraftDiffView
            original={latestVersion.content}
            modified={currentContent}
            language={type === "agent" ? "markdown" : undefined}
            originalLabel={versionLabel}
            modifiedLabel={activeLabel}
          />
        )}
    </>
  );
}
