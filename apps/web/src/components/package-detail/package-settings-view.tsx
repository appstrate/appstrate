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
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { FileArchive, FolderTree, History, IdCard } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { Versioned } from "../../hooks/use-packages";
import type { PackageSettingsSection } from "../../lib/settings-section-href";
import { SettingsSkeleton } from "../loading-skeletons";
import { SettingsRailView } from "../settings/settings-rail-view";
import { PackageCommonSection, type PackageVersionsProps } from "./package-common-section";

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
  versions: PackageVersionsProps;
  type: "skill" | "mcp-server";
  packageId: string;
  detail: Versioned<OrgPackageItemDetail> | undefined;
  /** A pinned version being read; the definition is only edited on the draft. */
  version?: string;
}) {
  const { t } = useTranslation("agents");
  // Write authority is the package's HOME space, never the space being browsed.
  const editable = !!detail?.home_writable && version === undefined;
  // A system package has no history of its own to browse (same rule as agents).
  const hasVersions = detail?.source !== "system";

  const resolve = (requested: string | null): PackageSettingsSection => {
    if (requested === "versions" && hasVersions) return "versions";
    if (requested === "general" && editable) return "general";
    // Contenu reads the bundle, so whoever reads the package reads it.
    return requested === "bundle" ? "bundle" : "files";
  };
  const groups = [
    {
      title: t("detail.settings.exploreGroup"),
      items: [
        { id: "files" as const, icon: FolderTree, label: t("detail.overview.explorer") },
        ...(hasVersions
          ? [{ id: "versions" as const, icon: History, label: t("detail.settings.versions") }]
          : []),
      ],
    },
    {
      title: t("detail.settings.definitionGroup"),
      items: [
        ...(editable
          ? [{ id: "general" as const, icon: IdCard, label: t("editor.tabGeneral") }]
          : []),
        { id: "bundle" as const, icon: FileArchive, label: t("editor.tabPackageFiles") },
      ],
    },
  ];

  return (
    <SettingsRailView
      param="packageSettings"
      tab="settings"
      label={t("detail.tabSettings")}
      groups={groups}
      resolve={resolve}
    >
      {({ active, file, href }) =>
        active === "general" && detail ? (
          <Suspense fallback={<SettingsSkeleton />}>
            <PackageDefinitionEditor type={type} detail={detail} />
          </Suspense>
        ) : (
          <PackageCommonSection
            section={active === "general" ? "files" : active}
            type={type}
            packageId={packageId}
            manifest={detail?.manifest ?? {}}
            file={file}
            href={href}
            version={version}
            manifestSection={editable ? "general" : undefined}
            versions={versions}
          />
        )
      }
    </SettingsRailView>
  );
}
