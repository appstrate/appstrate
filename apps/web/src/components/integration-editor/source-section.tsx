// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { FormField } from "../form-field";
import { useAppConfig } from "../../hooks/use-app-config";
import { LocalServerFields } from "./local-server-fields";
import { getSource, setSource, type SourceKind } from "./utils";

interface SourceSectionProps {
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
  /** Paths of the package's draft files, to check the local entry point against. */
  serverFiles?: readonly string[];
  /** Flag the empty required fields (after a refused save). */
  showErrors?: boolean;
}

export function SourceSection({ manifest, onChange, serverFiles, showErrors }: SourceSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const source = getSource(manifest);
  const { localIntegrations } = useAppConfig().features;
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
      {source.kind === "local" && !localIntegrations && (
        // Authoring stays possible; it only cannot run on this instance.
        <p className="text-muted-foreground -mt-3 text-sm" data-testid="local-unavailable-notice">
          <span className="font-medium">
            {t("integrations.source.localUnavailable", { ns: "settings" })}
          </span>
          {" · "}
          {t("integrations.source.localUnavailableHint", { ns: "settings" })}
        </p>
      )}

      {source.kind === "remote" && (
        <>
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
          />
        </>
      )}

      {source.kind === "local" && (
        <LocalServerFields
          source={source}
          onChange={update}
          serverFiles={serverFiles}
          showErrors={showErrors}
        />
      )}

      {source.kind === "none" && (
        <p className="text-muted-foreground text-sm">{t("integrationEditor.source.noneDesc")}</p>
      )}
    </section>
  );
}
