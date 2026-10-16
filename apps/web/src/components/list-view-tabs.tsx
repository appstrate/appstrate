// SPDX-License-Identifier: Apache-2.0

import { ManualSetting } from "./settings/manual-save";
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
    <ManualSetting compact value={view} onSave={async (next) => onChange(next)}>
      {(value, setValue, pending) => (
        <Tabs
          value={value}
          onValueChange={(next) => {
            if (next === "cards" || next === "table") setValue(next);
          }}
        >
          <TabsList className="h-9">
            <TabsTrigger disabled={pending} value="table" aria-label={t("toolbar.viewTable")}>
              <Rows3 className="size-4" />
            </TabsTrigger>
            <TabsTrigger disabled={pending} value="cards" aria-label={t("toolbar.viewCards")}>
              <LayoutGrid className="size-4" />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}
    </ManualSetting>
  );
}
