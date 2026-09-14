// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { FormField } from "../form-field";
import { EditorSection, type EditorSurface } from "./editor-section";
import { LocalServerField } from "./local-server-field";
import { getSource, setSource, type SourceKind } from "./utils";

interface SourceSectionProps {
  /** `settings` inside the edit panel, `card` on the editor page. */
  surface?: EditorSurface;
  manifest: Record<string, unknown>;
  onChange: (manifest: Record<string, unknown>) => void;
}

export function SourceSection({ manifest, onChange, surface = "card" }: SourceSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const source = getSource(manifest);
  const update = (patch: Partial<typeof source>) =>
    onChange(setSource(manifest, { ...source, ...patch }));

  return (
    <EditorSection surface={surface} title={t("integrationEditor.source.title")}>
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
        <LocalServerField
          name={source.serverName}
          version={source.serverVersion}
          onChange={update}
        />
      )}

      {source.kind === "none" && (
        <p className="text-muted-foreground text-sm">{t("integrationEditor.source.noneDesc")}</p>
      )}
    </EditorSection>
  );
}
