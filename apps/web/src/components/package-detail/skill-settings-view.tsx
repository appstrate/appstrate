// SPDX-License-Identifier: Apache-2.0

/**
 * A skill's Paramètres, in the shape an agent's and an integration's have.
 *
 * A skill has no configuration of its own in a space, so two groups, not
 * three: Explorer (its files, read) and Définition (what it is, edited in
 * place by whoever may write it). The raw manifest is not a section — every
 * form writes into it — but a modal reached from under Identité and from
 * `manifest.json` in the files.
 */
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { FileText, FolderTree, IdCard } from "lucide-react";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import type { SkillDefinitionSection } from "../../pages/package-editor";
import { primaryDisplayFile } from "../../lib/package-files";
import { AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { LoadingState } from "../page-states";
import { FileExplorer } from "../package-files/file-explorer";
import { RailLink } from "../settings/rail-link";

const SkillDefinitionEditor = lazy(() =>
  import("../../pages/package-editor").then((module) => ({
    default: module.SkillDefinitionEditor,
  })),
);

type SkillSettingsSection = "files" | SkillDefinitionSection;

export function SkillSettingsView({
  packageId,
  detail,
  version,
  canEditDefinition,
}: {
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

  const requested = new URLSearchParams(location.search).get("skillSettings");
  const active: SkillSettingsSection =
    editable && (requested === "general" || requested === "content") ? requested : "files";

  const sectionHref = (section: SkillSettingsSection, modal?: "edit" | "editManifest") => {
    const search = new URLSearchParams(location.search);
    if (section === "files") search.delete("skillSettings");
    else search.set("skillSettings", section);
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
      items: [{ id: "files" as const, icon: FolderTree, label: t("detail.overview.explorer") }],
    },
    ...(editable
      ? [
          {
            label: t("detail.settings.definitionGroup"),
            items: [
              { id: "general" as const, icon: IdCard, label: t("editor.tabIdentity") },
              { id: "content" as const, icon: FileText, label: t("editor.tabContent") },
            ],
          },
        ]
      : []),
  ];

  return (
    <AgentDetailSplit
      data-skill-settings
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
      {active !== "files" && detail ? (
        <Suspense fallback={<LoadingState />}>
          <SkillDefinitionEditor
            detail={detail}
            section={active}
            onSection={(next) => void navigate(sectionHref(next))}
          />
        </Suspense>
      ) : (
        <FileExplorer
          packageId={packageId}
          type="skill"
          version={version}
          editHref={
            editable
              ? (path) =>
                  path === primaryDisplayFile("skill").name
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
