// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { LayoutGrid, Rows3 } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@appstrate/ui/components/toggle-group";
import type { ListView } from "../stores/list-view-store";

export function ListViewTabs({
  view,
  onChange,
}: {
  view: ListView;
  onChange: (view: ListView) => void;
}) {
  const { t } = useTranslation("common");
  return (
    <ToggleGroup<ListView>
      aria-label={t("toolbar.viewMode")}
      className="bg-muted h-8 shrink-0 gap-0 rounded-md p-0.5"
      value={[view]}
      onValueChange={([next]) => next && onChange(next)}
    >
      <ToggleGroupItem
        className="data-pressed:bg-background h-7 min-w-7 px-1.5"
        value="table"
        aria-label={t("toolbar.viewTable")}
      >
        <Rows3 className="size-4" />
      </ToggleGroupItem>
      <ToggleGroupItem
        className="data-pressed:bg-background h-7 min-w-7 px-1.5"
        value="cards"
        aria-label={t("toolbar.viewCards")}
      >
        <LayoutGrid className="size-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
