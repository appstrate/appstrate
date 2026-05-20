// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime tools checklist for the agent editor. Replaces the former
 * "Tools" dependency tab — runtime tools are no longer AFPS packages but
 * built-in factories the runner injects per-agent.
 *
 * `output` is mandatory: it is always injected regardless of selection,
 * so it renders checked + disabled with an "always on" hint and is never
 * written to the manifest. The selectable tools (`log`/`note`/`pin`/
 * `report`) toggle membership in `manifest.runtimeTools: string[]`.
 */

import { useTranslation } from "react-i18next";
import { RUNTIME_TOOL_CATALOG } from "@appstrate/core/runtime-tools-catalog";
import { Checkbox } from "@/components/ui/checkbox";
import { SectionCard } from "../section-card";

interface RuntimeToolsSectionProps {
  /** Currently selected selectable runtime tool ids (manifest.runtimeTools). */
  selected: string[];
  onChange: (next: string[]) => void;
}

export function RuntimeToolsSection({ selected, onChange }: RuntimeToolsSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const selectedSet = new Set(selected);

  const toggle = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  return (
    <SectionCard title={t("editor.tabRuntimeTools")}>
      <p className="text-muted-foreground mb-3 text-xs">{t("editor.runtimeToolsHint")}</p>
      <div className="flex flex-col gap-1">
        {RUNTIME_TOOL_CATALOG.map((tool) => {
          const checked = tool.mandatory || selectedSet.has(tool.id);
          return (
            <label
              key={tool.id}
              className={
                tool.mandatory
                  ? "flex cursor-not-allowed items-start gap-2.5 px-3 py-2 opacity-70"
                  : "hover:bg-muted/50 flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2"
              }
              data-testid={`runtime-tool-${tool.id}`}
            >
              <Checkbox
                checked={checked}
                disabled={tool.mandatory}
                onCheckedChange={tool.mandatory ? undefined : () => toggle(tool.id)}
                className="mt-0.5"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {tool.displayName}
                  {tool.mandatory && (
                    <span className="text-muted-foreground text-[10px] font-normal">
                      {t("editor.runtimeToolsAlwaysOn")}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">{tool.description}</span>
              </div>
            </label>
          );
        })}
      </div>
    </SectionCard>
  );
}
