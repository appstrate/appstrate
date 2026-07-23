// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime tools rendered as a system "integration" card inside the agent
 * editor's Integrations section — visually identical to any other
 * (system) integration entry: bordered card, name + system badge, and a
 * per-tool checklist mirroring `IntegrationToolPicker`'s tool list.
 *
 * Backed by the platform runtime tools (`output`/`log`/`note`/`pin`),
 * which are MCP tool definitions hosted by the sidecar
 * (`@appstrate/core/runtime-tool-defs`) — NOT an installable AFPS
 * integration. So unlike real integrations there is no version, no auth,
 * and no connection: the group is always present (a checked, disabled
 * header checkbox conveys "always available"), and toggling a tool writes
 * `manifest.runtime_tools: string[]` rather than `dependencies.integrations`.
 */

import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { RUNTIME_TOOL_CATALOG } from "@appstrate/core/runtime-tools-catalog";
import { Checkbox } from "@appstrate/ui/components/checkbox";

interface RuntimeToolsGroupProps {
  /** Currently selected runtime tool ids (manifest.runtime_tools). */
  selected: string[];
  onChange: (next: string[]) => void;
}

export function RuntimeToolsGroup({ selected, onChange }: RuntimeToolsGroupProps) {
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
    <div
      className="border-primary bg-primary/5 rounded-md border"
      data-testid="runtime-tools-group"
    >
      {/* Header — same layout as a selected integration card (checkbox +
          name + system badge + description). The checkbox is checked and
          disabled: the group is intrinsic to the platform, not installable. */}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Checkbox checked disabled aria-label={t("editor.tabRuntimeTools")} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 truncate text-sm font-medium">
            {t("editor.tabRuntimeTools")}
            <ShieldCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {t("editor.runtimeToolsHint")}
          </span>
        </div>
      </div>

      {/* Per-tool checklist — mirrors IntegrationToolPicker's tool list. */}
      <div className="px-3 pb-3">
        <div className="bg-muted/30 grid gap-1.5 rounded-md border p-3">
          {RUNTIME_TOOL_CATALOG.map((tool) => (
            <label
              key={tool.id}
              className="flex cursor-pointer items-start gap-2 text-xs"
              data-testid={`runtime-tool-${tool.id}`}
            >
              <Checkbox
                checked={selectedSet.has(tool.id)}
                onCheckedChange={() => toggle(tool.id)}
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-mono">{tool.id}</span>
                <span className="text-muted-foreground">{tool.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
