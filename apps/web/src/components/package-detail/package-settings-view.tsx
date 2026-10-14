// SPDX-License-Identifier: Apache-2.0

/**
 * Paramètres for the packages with nothing set per space — skills and local
 * MCP servers — in the shape an agent's and an integration's have.
 *
 * Two groups, not three: Explorer (the tree, where files are changed, and the
 * versions) and Package AFPS (what the archive holds): Identité, the
 * manifest's form, for whoever may write it, and Contenu, the table of every
 * file, for whoever reads the package. The raw manifest is not a section (every
 * form writes into it) but a modal reached from under Identité.
 */
import { lazy, Suspense, useCallback, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { FileArchive, FolderTree, History, IdCard } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { Versioned } from "../../hooks/use-packages";
import { EditorPlaceContext } from "../../hooks/use-unsaved-changes";
import type { EditorPlace } from "../../lib/editor-place";
import {
  packageSettingsHref,
  settingsEditorPlace,
  type PackageSettingsSection,
} from "../../lib/settings-section-href";
import { AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { PackageFilesSection } from "../package-files/package-files-section";
import { PackageFilesView } from "../package-files/package-files-view";
import { SectionRail, type SectionRailItem } from "../settings/section-rail";
import { PackageVersionsSection } from "./package-versions-section";
import { SettingsSkeleton } from "../loading-skeletons";

const PackageDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.PackageDefinitionEditor,
  })),
);

export function PackageSettingsView({
  type,
  packageId,
  detail,
  version,
  versions,
}: {
  versions: Omit<ComponentProps<typeof PackageVersionsSection>, "type" | "packageId">;
  type: "skill" | "mcp-server";
  packageId: string;
  detail: Versioned<OrgPackageItemDetail> | undefined;
  /** A pinned version being read; the definition is only edited on the draft. */
  version?: string;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  // Write authority is the package's HOME space, never the space being browsed.
  const editable = !!detail?.home_writable && version === undefined;
  // A system package has no history of its own to browse (same rule as agents).
  const hasVersions = detail?.source !== "system";

  const sectionOf = useCallback(
    (search: URLSearchParams): PackageSettingsSection => {
      const requested = search.get("packageSettings");
      if (requested === "versions" && hasVersions) return "versions";
      if (requested === "general" && editable) return "general";
      // Contenu reads the bundle, so whoever reads the package reads it.
      return requested === "bundle" ? "bundle" : "files";
    },
    [hasVersions, editable],
  );
  const params = new URLSearchParams(location.search);
  const active = sectionOf(params);
  const requestedFile = params.get("file") ?? undefined;
  const editorPlace = useCallback<EditorPlace>(
    (search) => settingsEditorPlace(sectionOf(search), search),
    [sectionOf],
  );
  const filesHref = (path: string) =>
    packageSettingsHref(location.pathname, "files", { file: path });

  const item = (id: PackageSettingsSection, icon: SectionRailItem["icon"], label: string) => ({
    id,
    to: packageSettingsHref(location.pathname, id),
    icon,
    label,
  });
  const groups = [
    {
      title: t("detail.settings.exploreGroup"),
      items: [
        item("files", FolderTree, t("detail.overview.explorer")),
        ...(hasVersions ? [item("versions", History, t("detail.settings.versions"))] : []),
      ],
    },
    {
      title: t("detail.settings.definitionGroup"),
      items: [
        ...(editable ? [item("general", IdCard, t("editor.tabGeneral"))] : []),
        item("bundle", FileArchive, t("editor.tabPackageFiles")),
      ],
    },
  ];

  return (
    <EditorPlaceContext.Provider value={editorPlace}>
      <AgentDetailSplit
        data-package-settings
        phoneMenu={t("detail.tabSettings")}
        rail={<SectionRail label={t("detail.tabSettings")} groups={groups} active={active} />}
      >
        {active === "versions" ? (
          <PackageVersionsSection type={type} packageId={packageId} {...versions} />
        ) : active === "bundle" ? (
          <PackageFilesSection
            type={type}
            packageId={packageId}
            manifest={detail?.manifest ?? {}}
            filesHref={filesHref}
          />
        ) : active === "general" && detail ? (
          <Suspense fallback={<SettingsSkeleton />}>
            <PackageDefinitionEditor type={type} detail={detail} />
          </Suspense>
        ) : (
          <PackageFilesView
            key={requestedFile}
            type={type}
            packageId={packageId}
            initialVersion={version}
            initialPath={requestedFile}
            editable={editable}
            editHref={
              editable
                ? (path) =>
                    path === "manifest.json"
                      ? packageSettingsHref(location.pathname, "general", { editManifest: "1" })
                      : undefined
                : undefined
            }
          />
        )}
      </AgentDetailSplit>
    </EditorPlaceContext.Provider>
  );
}
