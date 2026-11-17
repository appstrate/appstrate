// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Play, Square } from "lucide-react";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { HeaderActionButton } from "../header-action-button";

export function RunHeaderActions({
  canRerun,
  rerunRefusal,
  canCancel,
  rerunPending,
  cancelPending,
  onRerun,
  onCancel,
}: {
  canRerun: boolean;
  /** Why a re-run cannot start (switched off here, nothing published): said before the click. */
  rerunRefusal?: string | null;
  canCancel: boolean;
  rerunPending: boolean;
  cancelPending: boolean;
  onRerun: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <>
      {canRerun && (
        <DisabledReasonTooltip reason={rerunRefusal}>
          <HeaderActionButton onClick={onRerun} disabled={rerunPending || !!rerunRefusal}>
            <Play className="text-primary" />
            {t("run.rerun")}
          </HeaderActionButton>
        </DisabledReasonTooltip>
      )}
      {canCancel && (
        <HeaderActionButton onClick={onCancel} disabled={cancelPending}>
          <Square className="text-destructive" />
          {t("btn.cancel")}
        </HeaderActionButton>
      )}
    </>
  );
}
