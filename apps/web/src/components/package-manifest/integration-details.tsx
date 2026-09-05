// SPDX-License-Identifier: Apache-2.0

/**
 * Integration-specific tail of the manifest overview: where the MCP surface
 * comes from, and how a user authenticates to it.
 *
 * SCOPE, deliberately narrow. The integration page's Tools tab already renders
 * the server-RESOLVED tool catalog with its per-auth `required_scopes` — and
 * with the tool descriptions the raw manifest `tools_policy` does not carry —
 * so re-rendering that map here would be a strictly poorer duplicate on the
 * same page. What no other surface shows a caller without
 * `integrations:configure` is `source` and `auths`: the Configuration tab that
 * owns them needs exactly that permission. Hence these two, plus the
 * `allow_undeclared_tools` opt-in, which is a policy statement rather than a
 * tool listing.
 *
 * Deliberately NOT built out of `components/integration-editor/*`: those are
 * form controls, and a read view assembled from disabled inputs reads like a
 * form you are not allowed to submit. Duplicating the manifest's shape in
 * plain markup is the cheaper of the two.
 */

import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import type { IntegrationManifestDetails } from "../../lib/package-manifest";
import { SectionCard } from "../section-card";
import { FactGrid } from "./manifest-fact";

export function IntegrationDetails({ details }: { details: IntegrationManifestDetails }) {
  const { t } = useTranslation("agents");
  const { source, auths, allowUndeclaredTools } = details;

  return (
    <>
      {source && (
        <SectionCard title={t("manifest.source")}>
          {source.kind === "local" && (
            <>
              <p className="text-sm">{t("manifest.sourceLocal")}</p>
              <FactGrid
                facts={[
                  { labelKey: "manifest.serverPackage", value: source.serverName },
                  { labelKey: "manifest.serverVersion", value: source.serverVersion },
                ]}
              />
              {source.vendored && <Badge variant="secondary">{t("manifest.sourceVendored")}</Badge>}
            </>
          )}
          {source.kind === "remote" && (
            <>
              <p className="text-sm">{t("manifest.sourceRemote")}</p>
              {/* The remote URL stays TEXT: it addresses an MCP endpoint the
                  platform calls server-side, not a page a reader should open. */}
              <FactGrid
                facts={[
                  { labelKey: "manifest.sourceUrl", value: source.url },
                  { labelKey: "manifest.sourceTransport", value: source.transport },
                ]}
              />
            </>
          )}
          {source.kind === "none" && <p className="text-sm">{t("manifest.sourceNone")}</p>}
        </SectionCard>
      )}

      {auths.length > 0 && (
        <SectionCard title={t("manifest.auths")}>
          {auths.map((auth) => (
            <div key={auth.id} className="border-border/40 border-b pb-3 last:border-b-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm">{auth.id}</code>
                {auth.type && <Badge variant="secondary">{auth.type}</Badge>}
              </div>
              {auth.defaultScopes.length > 0 && (
                <>
                  <p className="text-muted-foreground mt-2 text-xs">
                    {t("manifest.defaultScopes")}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {/* Index in the key: `default_scopes` is author-controlled
                        jsonb and the reader keeps duplicates verbatim. */}
                    {auth.defaultScopes.map((scope, index) => (
                      <Badge
                        key={`${index}:${scope}`}
                        variant="outline"
                        className="font-mono text-[0.65rem]"
                      >
                        {scope}
                      </Badge>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </SectionCard>
      )}

      {allowUndeclaredTools && (
        <SectionCard title={t("manifest.toolsPolicy")}>
          <p className="text-muted-foreground text-xs">{t("manifest.allowUndeclaredTools")}</p>
        </SectionCard>
      )}
    </>
  );
}
