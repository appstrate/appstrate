// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

/** UI-level scope filter shared by the agent-level Memories + Checkpoints tabs. */
export type PersistenceScopeFilter = "all" | "shared" | "mine";

export function ScopeFilter({
  value,
  onChange,
}: {
  value: PersistenceScopeFilter;
  onChange: (next: PersistenceScopeFilter) => void;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">{t("detail.memoryScopeFilterLabel")}</span>
      <Select value={value} onValueChange={(v) => onChange(v as PersistenceScopeFilter)}>
        <SelectTrigger className="h-8 w-36 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("detail.memoryScopeAll")}</SelectItem>
          <SelectItem value="shared">{t("detail.memoryScopeShared")}</SelectItem>
          <SelectItem value="mine">{t("detail.memoryScopeMine")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
