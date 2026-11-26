// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { $api } from "../../api/client";
import { encodeIconDataUri } from "../../lib/icon-image";
import {
  connectionChoiceBody,
  mergeServerIdentity,
  type ServerIdentityKey,
  type ServerReadBlock,
} from "../../lib/integration-server-sync";
import { ServerReadControl } from "./server-read-control";

/**
 * Reads the draft's remote server and fills the identity fields the author left empty in the
 * draft (`onChange`); nothing is saved here. A raster the manifest does not accept as is (ICO,
 * large PNG) is re-encoded; one the browser cannot decode is skipped, and the icon lands only if
 * the draft still has none. When several connections could answer, the refusal's candidates are
 * offered and the chosen one retries.
 */
export function ServerIdentityFill({
  packageId,
  blockedBy,
  manifest,
  onChange,
}: {
  packageId: string;
  /** The draft's manifest. */
  manifest: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Why the server cannot be read: the button stays, disabled, with the reason as a tooltip. */
  blockedBy: ServerReadBlock | null;
}) {
  const { t } = useTranslation("agents");
  const [filled, setFilled] = useState<ServerIdentityKey[] | null>(null);
  // The draft as the last render saw it: the icon lands after an await, onto whatever the author
  // typed meanwhile.
  const draft = useRef(manifest);
  useEffect(() => {
    draft.current = manifest;
  });
  const read = $api.useMutation("post", "/api/integrations/{packageId}/discover", {
    // The error is rendered inline, under the button.
    meta: { errorHandledByCaller: true },
    onMutate: () => setFilled(null),
    onSuccess: async (proposal) => {
      const proposed = proposal.manifest as Record<string, unknown>;
      const merged = mergeServerIdentity(draft.current, proposed);
      onChange(merged.manifest);
      setFilled(merged.filled);
      if (!proposal.icon_source || proposed.icon) return;
      try {
        const icon = await encodeIconDataUri(proposal.icon_source);
        const current = draft.current;
        if (typeof current.icon === "string" && current.icon !== "") return;
        onChange({ ...current, icon });
        setFilled([...merged.filled, "icon"]);
      } catch {
        // An image the browser cannot decode: the identity stays without an icon.
      }
    },
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
    <ServerReadControl
      label={t("integrationEditor.identityFromServer.button")}
      blockedBy={blockedBy}
      isPending={read.isPending}
      error={read.error}
      onRun={run}
      testId="integration-editor-identity-from-server"
      buttonTestId="integration-editor-identity-from-server-button"
    >
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
    </ServerReadControl>
  );
}
