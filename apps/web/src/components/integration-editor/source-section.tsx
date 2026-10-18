// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import { Spinner } from "@appstrate/ui/components/spinner";
import { $api } from "../../api/client";
import { errorMessage } from "../../lib/mutation-error";
import type { DiscoveryBadges, DiscoveryProposal } from "../../lib/integration-discovery-merge";
import { FormField } from "../form-field";
import { DiscoveryBadge } from "./discovery-badge";
import { LocalServerField } from "./local-server-field";
import { getSource, setSource, type SourceKind } from "./utils";

interface SourceSectionProps {
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
  /** Creation only: analyses the remote URL into a proposal the editor merges. */
  discovery?: {
    onProposal: (proposal: DiscoveryProposal) => void;
    badges: DiscoveryBadges;
    warnings: DiscoveryProposal["warnings"];
  };
}

export function SourceSection({ manifest, onChange, discovery }: SourceSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  // Failure is shown inline under the field, not toasted.
  const analyse = $api.useMutation("post", "/api/integrations/discover", {
    meta: { errorHandledByCaller: true },
  });
  const source = getSource(manifest);
  const update = (patch: Partial<typeof source>) =>
    onChange(setSource(manifest, { ...source, ...patch }));

  return (
    <section className="flex max-w-2xl flex-col gap-5">
      <FormField
        id="int-source-kind"
        label={t("integrationEditor.source.kind")}
        value={source.kind}
        onChange={(v) => update({ kind: v as SourceKind })}
        enumValues={["remote", "local", "none"]}
        description={t("integrationEditor.source.kindDesc")}
      />

      {source.kind === "remote" && (
        <>
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <FormField
                id="int-source-url"
                label={t("integrationEditor.source.remoteUrl")}
                // Text, not `url`: a URL template (`{$variable.base_url}/mcp`) is
                // not a URL until a connection's values render it.
                required
                value={source.remoteUrl}
                onChange={(v) => update({ remoteUrl: v })}
                placeholder="https://example.com/mcp/v1"
                description={t("integrationEditor.source.remoteUrlDesc")}
              />
            </div>
            {discovery && (
              <Button
                type="button"
                variant="outline"
                className="mt-7"
                disabled={analyse.isPending || !URL.canParse(source.remoteUrl)}
                onClick={() =>
                  analyse.mutate(
                    { body: { url: source.remoteUrl } },
                    { onSuccess: discovery.onProposal },
                  )
                }
                data-testid="integration-editor-analyse"
              >
                {analyse.isPending && <Spinner />}
                {t("integrationEditor.discover.analyse")}
              </Button>
            )}
          </div>
          {analyse.error && (
            <p role="alert" className="text-destructive text-sm">
              {errorMessage(analyse.error)}
            </p>
          )}
          {discovery?.warnings.map((warning) => (
            <Alert key={warning.code} variant="warning">
              <AlertDescription>
                {t(`integrationEditor.discover.warning.${warning.code}`, {
                  defaultValue: warning.message,
                })}
              </AlertDescription>
            </Alert>
          ))}
          <FormField
            id="int-source-transport"
            label={t("integrationEditor.source.transport")}
            value={source.remoteTransport}
            // `FormField` hands back the raw `string` its widget holds. The
            // widget is a select over these two values, so anything else is
            // unreachable — narrow rather than coerce, so an impossible value
            // leaves the state untouched instead of silently becoming HTTP.
            onChange={(v) => {
              if (v === "streamable-http" || v === "sse") update({ remoteTransport: v });
            }}
            enumValues={["streamable-http", "sse"]}
            badge={<DiscoveryBadge provenance={discovery?.badges["/source/remote/transport"]} />}
          />
        </>
      )}

      {source.kind === "local" && (
        <LocalServerField
          name={source.serverName}
          version={source.serverVersion}
          onChange={update}
        />
      )}

      {source.kind === "none" && (
        <p className="text-muted-foreground text-sm">{t("integrationEditor.source.noneDesc")}</p>
      )}
    </section>
  );
}
