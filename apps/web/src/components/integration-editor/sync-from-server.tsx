// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { $api } from "../../api/client";
import { errorMessage } from "../../lib/mutation-error";
import type { ServerSyncProposal } from "../../lib/integration-discovery-merge";
import { DiscoveryWarnings } from "./discovery-warnings";

/**
 * Asks the connected MCP server for its tools and identity and hands the proposal to the editor,
 * which merges it into the draft; nothing is saved here.
 */
export function SyncFromServer({
  packageId,
  onProposal,
  result,
}: {
  packageId: string;
  onProposal: (proposal: ServerSyncProposal) => void;
  /** The last applied sync, for the confirmation line and its warnings. */
  result: { count: number; warnings: ServerSyncProposal["warnings"] } | null;
}) {
  const { t } = useTranslation("agents");
  // Failure is shown inline under the button, not toasted.
  const sync = $api.useMutation("post", "/api/integrations/{packageId}/discover", {
    meta: { errorHandledByCaller: true },
  });
  return (
    <div className="flex flex-col gap-3" data-testid="integration-editor-sync">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={sync.isPending}
          onClick={() =>
            sync.mutate({ params: { path: { packageId } }, body: {} }, { onSuccess: onProposal })
          }
          data-testid="integration-editor-sync-button"
        >
          {sync.isPending ? <Spinner /> : <RefreshCw />}
          {t("integrationEditor.sync.button")}
        </Button>
        {result && !sync.error && (
          <p className="text-muted-foreground text-sm" role="status">
            {t("integrationEditor.sync.done", { count: result.count })}
          </p>
        )}
      </div>
      {sync.error && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(sync.error)}
        </p>
      )}
      {result && <DiscoveryWarnings warnings={result.warnings} />}
    </div>
  );
}
