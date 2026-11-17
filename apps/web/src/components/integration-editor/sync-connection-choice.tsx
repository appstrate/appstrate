// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { candidateSelectOption } from "../../lib/connection-choice";
import { syncConnectionCandidates } from "../../lib/integration-server-sync";
import { OptionSelect } from "../app-ui/option-select";

/**
 * The connections a `must_choose_connection` sync refusal offers, as a picker whose choice
 * retries the sync with it. Nothing for any other error.
 */
export function SyncConnectionChoice({
  error,
  onChoose,
  disabled,
}: {
  error: unknown;
  onChoose: (connectionId: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("agents");
  const candidates = syncConnectionCandidates(error);
  if (!candidates?.length) return null;
  return (
    <OptionSelect
      value={undefined}
      onValueChange={onChoose}
      disabled={disabled}
      className="max-w-sm"
      aria-label={t("integrationEditor.sync.chooseConnection")}
      placeholder={t("integrationEditor.sync.chooseConnection")}
      options={candidates.map((c) =>
        candidateSelectOption(c, {
          sharedByOther: t("schedule.connectionOverrides.sharedByOther"),
          needsReconnection: t("schedule.connectionOverrides.needsReconnection"),
        }),
      )}
    />
  );
}
