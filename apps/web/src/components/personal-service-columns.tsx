// SPDX-License-Identifier: Apache-2.0

/**
 * The column set of the personal keys table (Settings › Models › Clés perso): one row per
 * service open to personal keys, its models, who plugged a key in, its state. The deed of a
 * row is « Choose the models » (the same checklist as an organization key's), in its « … »
 * menu and on a click of the row.
 */

import { useTranslation } from "react-i18next";
import { KeyRound, ListChecks } from "lucide-react";
import type { DataColumn } from "./data-table";
import { getProviderIcon } from "./icons";
import { ModelsCell } from "./provider-models-cell";
import { RowStateCell } from "./row-state-cell";
import { rowActionsColumn } from "./row-actions-column";
import { TableRowActions } from "./table-row-actions";
import { CellText } from "./table-cells";
import { rowStates, type PersonalServiceRow } from "../lib/model-providers";

interface PersonalServiceColumnsArgs {
  /** Resolved once by the page: the deed absent here 403s if clicked. */
  canWriteModels: boolean;
  onChooseModels: (row: PersonalServiceRow) => void;
}

/** « Alice Martin (vous), Bob » */
function holdersText(row: PersonalServiceRow, you: string): string {
  return row.holders.map((h) => `${h.name ?? "—"}${h.mine ? ` (${you})` : ""}`).join(", ");
}

export function usePersonalServiceColumns({
  canWriteModels,
  onChooseModels,
}: PersonalServiceColumnsArgs): DataColumn<PersonalServiceRow>[] {
  const { t } = useTranslation("settings");
  return [
    {
      id: "service",
      header: t("providers.col.provider"),
      width: 110,
      elastic: true,
      cell: (row) => {
        const Icon = getProviderIcon(row.service) ?? KeyRound;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <Icon className="text-muted-foreground size-4 shrink-0" />
            <CellText strong title={row.service.displayName}>
              {row.service.displayName}
            </CellText>
          </div>
        );
      },
    },
    {
      id: "models",
      header: t("providers.col.models"),
      width: 100,
      elastic: true,
      cell: (row) => <ModelsCell models={row.models} />,
    },
    {
      id: "keys",
      header: t("providers.col.keys"),
      width: 100,
      elastic: true,
      tier: 2,
      cell: (row) => {
        const text = row.holders.length > 0 ? holdersText(row, t("credentials.you")) : null;
        return text ? (
          <span className="block truncate text-sm" title={text}>
            {text}
          </span>
        ) : (
          <span className="text-muted-foreground block truncate text-sm">
            {t("providers.noKeys")}
          </span>
        );
      },
    },
    {
      id: "state",
      header: t("providers.col.state"),
      width: 100,
      elastic: true,
      tier: 2,
      cell: (row) => (
        <RowStateCell
          states={rowStates({ ...row, noKey: row.holders.length === 0 })}
          unavailableHint={t("credentials.unavailableHint")}
        />
      ),
    },
    rowActionsColumn((row) => (
      <TableRowActions
        menuLabel={t("providers.moreActions", { name: row.service.displayName })}
        actions={[
          {
            id: "choose-models",
            label: t("models.choice.title"),
            icon: ListChecks,
            onSelect: () => onChooseModels(row),
            hidden: !canWriteModels,
          },
        ]}
      />
    )),
  ];
}
