// SPDX-License-Identifier: Apache-2.0

/** Runtime tools are intrinsic to the platform, not versioned bundle dependencies. */

import { useTranslation } from "react-i18next";
import { RUNTIME_TOOL_CATALOG } from "@appstrate/core/runtime-tools-catalog";
import { PackageToolCatalog } from "../package-detail/package-tool-catalog";

interface RuntimeToolsGroupProps {
  /** Currently selected runtime tool ids (manifest.runtime_tools). */
  selected: string[];
  onChange: (next: string[]) => void;
  /** Off where the section heading already says what the tools are. */
  showHint?: boolean;
}

export function RuntimeToolsGroup({ selected, onChange, showHint = true }: RuntimeToolsGroupProps) {
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
    <div data-testid="runtime-tools-group">
      {showHint && (
        <p className="text-muted-foreground mb-4 text-sm">{t("editor.runtimeToolsHint")}</p>
      )}
      <PackageToolCatalog
        tools={RUNTIME_TOOL_CATALOG.map((tool) => ({
          name: tool.id,
          // The catalog's English line is the fallback; the UI speaks the reader's language.
          description: t(`editor.runtimeTool.${tool.id}`, { defaultValue: tool.description }),
        }))}
        selection={{ values: selectedSet, onToggle: toggle, testIdPrefix: "runtime-tool-" }}
      />
    </div>
  );
}
