// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { runStatusValues } from "@appstrate/core/run-status";
import type { FilterSpec } from "../components/list-toolbar";
import type { ListState } from "../lib/list-params";

/**
 * The status dimension every run list offers, read from and written to the
 * list's own state (the URL on a page, the component in a panel).
 */
export function useRunStatusFilter(list: Pick<ListState, "values" | "setValues">) {
  const { t } = useTranslation(["agents", "common"]);
  const statuses = list.values("status", runStatusValues);
  const filter: FilterSpec = {
    id: "status",
    label: t("runs.filterStatus"),
    values: statuses,
    options: runStatusValues.map((value) => ({
      value,
      label: t(`status.${value}`, { ns: "common" }),
    })),
    onChange: list.setValues("status"),
  };
  return { statuses, filter };
}
