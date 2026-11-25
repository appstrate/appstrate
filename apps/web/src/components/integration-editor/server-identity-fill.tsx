// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Spinner } from "@appstrate/ui/components/spinner";
import { $api } from "../../api/client";
import { errorMessage } from "../../lib/mutation-error";
import {
  connectionChoiceBody,
  type ServerIdentityKey,
  type ServerReadBlock,
  type ServerSyncProposal,
} from "../../lib/integration-server-sync";
import { DisabledReasonTooltip } from "../disabled-reason-tooltip";
import { SyncConnectionChoice } from "./sync-connection-choice";

/**
 * Reads the draft's remote server and fills the identity fields the author left empty. The merge is
 * the editor's (`apply`, which returns the fields it filled); nothing is saved here. When several
 * connections could answer, the refusal's candidates are offered and the chosen one retries.
 */
export function ServerIdentityFill({
  packageId,
  blockedBy,
  apply,
}: {
  packageId: string;
  /** Why the server cannot be read: the button stays, disabled, with the reason as a tooltip. */
  blockedBy: ServerReadBlock | null;
  apply: (proposal: ServerSyncProposal) => Promise<ServerIdentityKey[]>;
}) {
  const { t } = useTranslation("agents");
  const [filled, setFilled] = useState<ServerIdentityKey[] | null>(null);
  const read = $api.useMutation("post", "/api/integrations/{packageId}/discover", {
    // The error is rendered inline, under the button.
    meta: { errorHandledByCaller: true },
    onMutate: () => setFilled(null),
    onSuccess: async (proposal) => setFilled(await apply(proposal)),
  });
  const run = (connectionId?: string) =>
    read.mutate({
      params: { path: { packageId } },
      body: connectionChoiceBody(connectionId),
    });
  const labels: Record<ServerIdentityKey, string> = {
    display_name: t("editor.metaDisplayName"),
    description: t("editor.fieldDescLabel"),
    homepage: t("manifest.homepage"),
    icon: t("integrationEditor.icon.label"),
  };

  return (
    <div className="flex flex-col gap-2" data-testid="integration-editor-identity-from-server">
      <div className="flex flex-col items-start gap-2">
        <DisabledReasonTooltip
          reason={blockedBy && t(`integrationEditor.identityFromServer.blocked.${blockedBy}`)}
        >
          <Button
            type="button"
            variant="outline"
            disabled={read.isPending || blockedBy !== null}
            onClick={() => run()}
            data-testid="integration-editor-identity-from-server-button"
          >
            {read.isPending ? <Spinner /> : <RefreshCw />}
            {t("integrationEditor.identityFromServer.button")}
          </Button>
        </DisabledReasonTooltip>
        <p className="text-muted-foreground text-sm">
          {t("integrationEditor.identityFromServer.help")}
        </p>
        {filled && read.error == null && (
          <p className="text-muted-foreground text-sm" role="status">
            {filled.length > 0
              ? t("integrationEditor.identityFromServer.done", {
                  count: filled.length,
                  fields: filled.map((key) => labels[key]).join(", "),
                })
              : t("integrationEditor.identityFromServer.nothing")}
          </p>
        )}
      </div>
      {read.error != null && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(read.error)}
        </p>
      )}
      <SyncConnectionChoice error={read.error} onChoose={run} disabled={read.isPending} />
    </div>
  );
}
