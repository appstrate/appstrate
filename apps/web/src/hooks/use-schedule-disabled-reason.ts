// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { ScheduleWireDto } from "@appstrate/shared-types";

/** Why a schedule is disabled, in the user's words — `null` while it is enabled. */
export function useScheduleDisabledReason(
  reason: ScheduleWireDto["disabled_reason"],
): string | null {
  const { t } = useTranslation(["agents"]);
  return reason ? t(`schedule.disabledReason.${reason}`) : null;
}
