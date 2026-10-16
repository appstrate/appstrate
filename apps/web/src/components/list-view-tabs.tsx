// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { LayoutGrid, Rows3 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
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
    <Tabs
      value={view}
      onValueChange={(next) => {
        if (next === "cards" || next === "table") onChange(next);
      }}
    >
      <TabsList className="h-9">
        <TabsTrigger value="table" aria-label={t("toolbar.viewTable")}>
          <Rows3 className="size-4" />
        </TabsTrigger>
        <TabsTrigger value="cards" aria-label={t("toolbar.viewCards")}>
          <LayoutGrid className="size-4" />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
