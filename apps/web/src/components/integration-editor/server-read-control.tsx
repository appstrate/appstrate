// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { errorMessage } from "../../lib/mutation-error";
import type { ServerReadBlock } from "../../lib/integration-server-sync";
import type { SnapshotRefreshBlock } from "../../lib/integration-tool-snapshot";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { SyncConnectionChoice } from "./sync-connection-choice";

/**
 * The control that reads an integration's remote server: one button, shown disabled with its
 * reason when the read can only be refused, the refusal inline and, when several connections could
 * answer, the candidates the refusal offers (the chosen one retries). What the read does with the
 * answer, and the mutation behind it, are the caller's.
 */
export function ServerReadControl({
  label,
  blockedBy,
  isPending,
  error,
  onRun,
  testId,
  buttonTestId,
  children,
}: {
  label: string;
  /** Why the server cannot be read; `null` when it can. */
  blockedBy: ServerReadBlock | SnapshotRefreshBlock | null;
  isPending: boolean;
  error: unknown;
  onRun: (connectionId?: string) => void;
  testId?: string;
  buttonTestId?: string;
  /** What sits under the button: its help, the outcome of the last read. */
  children?: ReactNode;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex flex-col items-start gap-2" data-testid={testId}>
      <DisabledReasonTooltip reason={blockedBy && t(`serverRead.blocked.${blockedBy}`)}>
        <Button
          type="button"
          variant="outline"
          disabled={isPending || blockedBy !== null}
          onClick={() => onRun()}
          data-testid={buttonTestId}
        >
          {isPending ? <Spinner /> : <RefreshCw />}
          {label}
        </Button>
      </DisabledReasonTooltip>
      {children}
      {error != null && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(error)}
        </p>
      )}
      <SyncConnectionChoice error={error} onChoose={onRun} disabled={isPending} />
    </div>
  );
}
