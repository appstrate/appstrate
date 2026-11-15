// SPDX-License-Identifier: Apache-2.0
import { useTranslation } from "react-i18next";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { readIntegrationSource } from "../../lib/package-manifest";
import { CopyBlock } from "../copy-block";
import { IntegrationSourceLabel } from "../integration-source-label";
import { SettingValue } from "../settings/setting-row";

function accessInfo(detail: IntegrationDetailWire) {
  const source = readIntegrationSource(detail.manifest.source);
  const meta = detail.manifest._meta as Record<string, unknown> | undefined;
  const api = meta?.["dev.appstrate/api"] as { auths?: Record<string, unknown> } | undefined;
  const apiKeys = Object.keys(api?.auths ?? {});
  const mcp = source?.kind === "local" || source?.kind === "remote";
  return {
    source,
    apiKeys,
    type: mcp ? (apiKeys.length ? "both" : "mcp") : apiKeys.length ? "api" : "none",
  };
}

export function IntegrationFunctioning({ detail }: { detail: IntegrationDetailWire }) {
  const { t } = useTranslation("settings");
  const { source, apiKeys, type } = accessInfo(detail);
  return (
    <dl>
      <SettingValue label={t("integration.structure.access")}>
        {t(`integration.structure.type.${type}`)}
      </SettingValue>
      {source && source.kind !== "none" && (
        <SettingValue label={t("integrations.col.source")}>
          <IntegrationSourceLabel source={source.kind} />
        </SettingValue>
      )}
      {source?.kind === "local" && (
        <SettingValue label={t("integration.structure.localServer")}>
          <code>{source.serverType}</code> · <code>{source.entryPoint}</code>
        </SettingValue>
      )}
      {source?.kind === "remote" && (
        <SettingValue label={t("integration.structure.url")}>
          <CopyBlock value={source.url} />
        </SettingValue>
      )}
      {apiKeys.map((key) => (
        <SettingValue
          key={key}
          label={
            <>
              {t("integration.structure.addresses")} · {key}
            </>
          }
        >
          {(detail.manifest.auths?.[key]?.authorized_uris ?? []).map((uri) => (
            <CopyBlock key={uri} value={uri} />
          ))}
        </SettingValue>
      ))}
    </dl>
  );
}
