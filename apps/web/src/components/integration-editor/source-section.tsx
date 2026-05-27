// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { FormField } from "../form-field";
import { SectionCard } from "../section-card";
import { getSource, setSource, type SourceKind } from "./utils";

interface SourceSectionProps {
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
}

export function SourceSection({ manifest, onChange }: SourceSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const source = getSource(manifest);
  const update = (patch: Partial<typeof source>) =>
    onChange(setSource(manifest, { ...source, ...patch }));

  return (
    <SectionCard title={t("integrationEditor.source.title")}>
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
          <FormField
            id="int-source-url"
            label={t("integrationEditor.source.remoteUrl")}
            type="url"
            required
            value={source.remoteUrl}
            onChange={(v) => update({ remoteUrl: v })}
            placeholder="https://example.com/mcp/v1"
          />
          <FormField
            id="int-source-transport"
            label={t("integrationEditor.source.transport")}
            value={source.remoteTransport}
            onChange={(v) => update({ remoteTransport: v })}
            enumValues={["streamable-http", "sse"]}
          />
        </>
      )}

      {source.kind === "local" && (
        <>
          <FormField
            id="int-source-server-name"
            label={t("integrationEditor.source.serverName")}
            required
            value={source.serverName}
            onChange={(v) => update({ serverName: v })}
            placeholder="@scope/my-mcp-server"
            description={t("integrationEditor.source.serverNameDesc")}
          />
          <FormField
            id="int-source-server-version"
            label={t("integrationEditor.source.serverVersion")}
            value={source.serverVersion}
            onChange={(v) => update({ serverVersion: v })}
            placeholder="^1.0.0"
          />
        </>
      )}

      {source.kind === "none" && (
        <p className="text-muted-foreground text-sm">{t("integrationEditor.source.noneDesc")}</p>
      )}
    </SectionCard>
  );
}
