// SPDX-License-Identifier: Apache-2.0
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { readIntegrationSource } from "../../lib/package-manifest";
import { CopyBlock } from "../copy-block";
import { SettingValue } from "../settings/setting-row";
import { packageDetailPath } from "../../lib/package-paths";

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
        <SettingValue label={t("integration.structure.hosting")}>
          {t(
            source.kind === "local"
              ? "integration.structure.local"
              : "integration.structure.remote",
          )}
        </SettingValue>
      )}
      {source?.kind === "local" && (
        <SettingValue label={t("integration.structure.serverPackage")}>
          <Link
            className="text-primary hover:underline"
            to={packageDetailPath("mcp-server", source.serverName)}
          >
            {source.serverName}
          </Link>{" "}
          {source.serverVersion}
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
