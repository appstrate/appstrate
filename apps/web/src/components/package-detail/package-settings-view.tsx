// SPDX-License-Identifier: Apache-2.0

/**
 * Paramètres for the packages with nothing set per space — skills and local
 * MCP servers — in the shape an agent's and an integration's have.
 *
 * Two groups, not three: Explorer (the files, read) and Définition (what the
 * package is, edited in place by whoever may write it). A skill's Définition
 * is Identité and Contenu (SKILL.md); a server's is Identité alone, its server
 * block and tools living in the manifest. The raw manifest is not a section —
 * every form writes into it — but a modal reached from under Identité and from
 * `manifest.json` in the files.
 */
import { lazy, Suspense, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { FileText, FolderTree, History, IdCard } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { SkillDefinitionSection } from "../../pages/package-editor";
import { primaryDisplayFile } from "../../lib/package-files";
import { AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { LoadingState } from "../page-states";
import { FileExplorer } from "../package-files/file-explorer";
import { RailLink } from "../settings/rail-link";
import { PackageVersionsSection } from "./package-versions-section";

const SkillDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.SkillDefinitionEditor,
  })),
);
const McpServerDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.McpServerDefinitionEditor,
  })),
);

type PackageSettingsSection = "files" | "versions" | SkillDefinitionSection;

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
  const navigate = useNavigate();
  const editable = canEditDefinition && Boolean(detail) && version === undefined;

  const requested = new URLSearchParams(location.search).get("packageSettings");
  const sections: SkillDefinitionSection[] =
    type === "skill" ? ["general", "content"] : ["general"];
  const active: PackageSettingsSection =
    requested === "versions" && versions.isOwned
      ? "versions"
      : editable && sections.includes(requested as SkillDefinitionSection)
        ? (requested as SkillDefinitionSection)
        : "files";

  const sectionHref = (section: PackageSettingsSection, modal?: "edit" | "editManifest") => {
    const search = new URLSearchParams(location.search);
    if (section === "files") search.delete("packageSettings");
    else search.set("packageSettings", section);
    // A modal belongs to the section it was opened in.
    search.delete("edit");
    search.delete("editManifest");
    if (modal) search.set(modal, "1");
    const query = search.toString();
    return `${location.pathname}${query ? `?${query}` : ""}#settings`;
  };

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
    ...(editable
      ? [
          {
            label: t("detail.settings.definitionGroup"),
            items: [
              { id: "general" as const, icon: IdCard, label: t("editor.tabIdentity") },
              ...(type === "skill"
                ? [{ id: "content" as const, icon: FileText, label: t("editor.tabContent") }]
                : []),
            ],
          },
        ]
      : []),
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
      ) : active !== "files" && detail ? (
        <Suspense fallback={<LoadingState />}>
          {type === "skill" ? (
            <SkillDefinitionEditor
              detail={detail}
              section={active}
              onSection={(next) => void navigate(sectionHref(next))}
            />
          ) : (
            <McpServerDefinitionEditor detail={detail} />
          )}
        </Suspense>
      ) : (
        <FileExplorer
          packageId={packageId}
          type={type}
          version={version}
          editHref={
            editable
              ? (path) =>
                  type === "skill" && path === primaryDisplayFile("skill").name
                    ? sectionHref("content", "edit")
                    : path === "manifest.json"
                      ? sectionHref("general", "editManifest")
                      : undefined
              : undefined
          }
        />
      )}
    </AgentDetailSplit>
  );
}
