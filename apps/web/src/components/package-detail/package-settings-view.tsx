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
import { lazy, Suspense, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { FileArchive, FolderTree, History, IdCard } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import { AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { LoadingState } from "../page-states";
import { PackageFilesSection } from "../package-files/package-files-section";
import { PackageFilesView } from "../package-files/package-files-view";
import { RailLink } from "../settings/rail-link";
import { PackageVersionsSection } from "./package-versions-section";

const PackageDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.PackageDefinitionEditor,
  })),
);

/** Package AFPS › Contenu is `bundle` in the URL: `files` is Explorer's tree. */
type PackageSettingsSection = "files" | "versions" | "general" | "bundle";

export function PackageSettingsView({
  type,
  packageId,
  detail,
  version,
  canEditDefinition,
  versions,
}: {
  versions: Omit<ComponentProps<typeof PackageVersionsSection>, "type" | "packageId">;
  type: "skill" | "mcp-server";
  packageId: string;
  detail: OrgPackageItemDetail | undefined;
  /** A pinned version being read; the definition is only edited on the draft. */
  version?: string;
  canEditDefinition: boolean;
}) {
  const { t } = useTranslation("agents");
  const location = useLocation();
  const editable = canEditDefinition && Boolean(detail) && version === undefined;

  const params = new URLSearchParams(location.search);
  const requested = params.get("packageSettings");
  const requestedFile = params.get("file") ?? undefined;
  const active: PackageSettingsSection =
    requested === "versions" && versions.isOwned
      ? "versions"
      : editable && requested === "general"
        ? "general"
        : // Contenu reads the bundle, so whoever reads the package reads it.
          requested === "bundle"
          ? "bundle"
          : "files";

  const sectionHref = (
    section: PackageSettingsSection,
    options: { modal?: { name: "edit" | "editManifest"; value: string }; file?: string } = {},
  ) => {
    const search = new URLSearchParams(location.search);
    if (section === "files") search.delete("packageSettings");
    else search.set("packageSettings", section);
    // A modal, or the file a link opened, belongs to the section it was opened in.
    search.delete("edit");
    search.delete("editManifest");
    search.delete("file");
    if (options.modal) search.set(options.modal.name, options.modal.value);
    if (options.file) search.set("file", options.file);
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#settings`;
  };
  const filesHref = (path: string) => sectionHref("files", { file: path });

  const groups = [
    {
      label: t("detail.settings.exploreGroup"),
      items: [
        {
          id: "files" as PackageSettingsSection,
          icon: FolderTree,
          label: t("detail.overview.explorer"),
        },
        ...(versions.isOwned
          ? [
              {
                id: "versions" as PackageSettingsSection,
                icon: History,
                label: t("detail.settings.versions"),
              },
            ]
          : []),
      ],
    },
    {
      label: t("detail.settings.definitionGroup"),
      items: [
        ...(editable
          ? [{ id: "general" as const, icon: IdCard, label: t("editor.tabIdentity") }]
          : []),
        { id: "bundle" as const, icon: FileArchive, label: t("editor.tabPackageFiles") },
      ],
    },
  ];

  return (
    <AgentDetailSplit
      data-package-settings
      railClassName="p-6"
      rail={
        <nav className="space-y-5" aria-label={t("detail.tabSettings")}>
          {groups.map((group) => (
            <section key={group.label}>
              <h2 className="text-muted-foreground mb-1 px-2 text-[11px] font-semibold tracking-wide uppercase">
                {group.label}
              </h2>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <RailLink
                    key={item.id}
                    item={{ to: sectionHref(item.id), icon: item.icon, labelKey: item.label }}
                    label={item.label}
                    active={active === item.id}
                  />
                ))}
              </div>
            </section>
          ))}
        </nav>
      }
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
        <Suspense fallback={<LoadingState />}>
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
                    ? sectionHref("general", { modal: { name: "editManifest", value: "1" } })
                    : undefined
              : undefined
          }
        />
      )}
    </AgentDetailSplit>
  );
}
