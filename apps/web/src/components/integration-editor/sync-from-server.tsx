// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { errorMessage } from "../../lib/mutation-error";
import type { ServerSyncProposal } from "../../lib/integration-discovery-merge";
import { DiscoveryWarnings } from "./discovery-warnings";

export interface ServerSyncResult {
  count: number;
  warnings: ServerSyncProposal["warnings"];
  /** The server's instructions were staged as the package's `INTEGRATION.md`. */
  docProposed: boolean;
}

/**
 * Asks the connected MCP server for its tools and identity. The request is the editor's, which
 * merges the proposal into the draft; nothing is saved here.
 */
export function SyncFromServer({
  run,
  isPending,
  error,
  result,
}: {
  run: () => void;
  isPending: boolean;
  error: unknown;
  /** The last applied sync, for the confirmation line and its warnings. */
  result: ServerSyncResult | null;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="flex flex-col gap-3" data-testid="integration-editor-sync">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={run}
          data-testid="integration-editor-sync-button"
        >
          {isPending ? <Spinner /> : <RefreshCw />}
          {t("integrationEditor.sync.button")}
        </Button>
        {result && error == null && (
          <p className="text-muted-foreground text-sm" role="status">
            {t("integrationEditor.sync.done", { count: result.count })}
            {result.docProposed && ` ${t("integrationEditor.sync.docProposed")}`}
          </p>
        )}
      </div>
      {error != null && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(error)}
        </p>
      )}
      {result && <DiscoveryWarnings warnings={result.warnings} />}
    </div>
  );
}
