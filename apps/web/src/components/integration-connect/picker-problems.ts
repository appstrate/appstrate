// SPDX-License-Identifier: Apache-2.0

/** What a picker problem says and how a test finds it: the same in the cell and in the modal. */

import type { TFunction } from "i18next";
import type { ConnectionPicker, PickerProblem } from "./use-connection-picker";

/** What a problem says, the same sentence in the cell and in the modal. */
export function problemText(
  t: TFunction,
  problem: PickerProblem,
  picker: Pick<ConnectionPicker, "missingScopeLabels">,
): string {
  switch (problem.kind) {
    case "unavailable":
      return t(
        problem.fromDefault
          ? "detail.integrationMemberPicker.defaultUnavailableWarning"
          : "detail.integrationMemberPicker.unavailableWarning",
        { count: problem.count },
      );
    case "imposedUnavailable":
      return t("detail.integrationMemberPicker.lockedUnavailableWarning", {
        count: problem.count,
      });
    case "tooLarge":
      return t("error.connectionSetTooLarge");
    case "dead":
      return t("detail.integrationMemberPicker.needsReconnectionLine", {
        name: problem.conn.label,
      });
    case "underScoped":
      return t("detail.integrationMemberPicker.missingScopesLine", {
        name: problem.conn.label,
        scopes: picker.missingScopeLabels(problem.conn).join(", "),
      });
  }
}

/** A problem's test id: `<prefix>-<kind>-warning-<the connection, else the integration>`. */
export function problemTestId(prefix: string, integrationId: string, problem: PickerProblem) {
  const kind = {
    unavailable: "unavailable",
    imposedUnavailable: "locked-unavailable",
    tooLarge: "too-large",
    dead: "dead",
    underScoped: "scope",
  }[problem.kind];
  const key = "conn" in problem ? problem.conn.id : integrationId;
  return `${prefix}-${kind}-warning-${key}`;
}
