// SPDX-License-Identifier: Apache-2.0

import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ExternalLink, KeyRound } from "lucide-react";
import { isFileField } from "@appstrate/core/form";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { Button } from "@appstrate/ui/components/button";
import { usePackageDetail } from "../../hooks/use-packages";
import { useApiKeys } from "../../hooks/use-api-keys";
import { useOrg } from "../../hooks/use-org";
import { usePermissions } from "../../hooks/use-permissions";
import { useCanReach } from "../../hooks/use-can-reach";
import { useModalParam } from "../../hooks/use-modal-param";
import { buildCurlJson, buildCurlMultipart } from "../../lib/agent-api-request";
import { ApiKeyCreateModal, NEW_API_KEY_PARAM } from "../api-key-create-modal";
import { CopyBlock } from "../copy-block";
import { SettingsHeading } from "../settings/settings-heading";

const API_KEYS_PAGE = "/workspace-settings/api-keys";

/** The launch answers `201` with the run resource; abridged here. */
const RUN_RESPONSE_EXAMPLE = `{
  "id": "run_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "status": "pending",
  …
}`;

function Block({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

/** How to launch this agent over HTTP, with a key of the space when the reader may hold one. */
export function AgentApiTab({ packageId }: { packageId: string }) {
  const { t } = useTranslation(["agents", "common"]);
  const { data: detail } = usePackageDetail("agent", packageId);
  const { data: apiKeys, isLoading: keysLoading } = useApiKeys();
  const { currentOrg } = useOrg();
  const { can } = usePermissions();
  // The key section follows the keys page, absent in a personal space.
  const canReach = useCanReach();
  const newApiKey = useModalParam(NEW_API_KEY_PARAM);
  const [rawKey, setRawKey] = useState<string | null>(null);

  if (!detail || !currentOrg) return null;

  const firstKey = apiKeys?.[0] ?? null;
  const maskedKey = firstKey ? `${firstKey.keyPrefix}${"•".repeat(28)}` : null;
  const schema = detail.input.schema;
  const request = {
    packageId,
    orgId: currentOrg.id,
    authToken: rawKey ?? maskedKey ?? "<your-api-key>",
    inputSchema: schema,
    baseUrl: window.location.origin,
  };
  const fileKeys = Object.entries(schema.properties ?? {})
    .filter(([, prop]) => isFileField(prop))
    .map(([key]) => key);
  const curlMultipart = fileKeys.length > 0 ? buildCurlMultipart(request) : null;
  // A required file cannot travel in a JSON body.
  const hasRequiredFile = fileKeys.some((key) => schema.required?.includes(key));
  const showKeys = canReach(API_KEYS_PAGE);

  return (
    <div className="space-y-6">
      <SettingsHeading level="group" title={t("api.title")} className="mb-0" />

      {showKeys &&
        (keysLoading ? (
          <p className="text-muted-foreground text-sm">{t("loading", { ns: "common" })}</p>
        ) : !firstKey && !rawKey ? (
          <Alert variant="warning">
            <KeyRound />
            <AlertTitle>{t("api.noKey")}</AlertTitle>
            <AlertDescription className="text-muted-foreground space-y-2">
              <p>{t("api.noKeyHint")}</p>
              {can("api-keys:create") && (
                <Button size="sm" onClick={() => newApiKey.open()}>
                  {t("api.createKey")}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t("api.selectKey")} :</span>
              <code className="bg-muted/50 truncate rounded px-2 py-0.5 font-mono text-xs">
                {rawKey ? `${rawKey.slice(0, 13)}${"•".repeat(20)}` : maskedKey}
              </code>
              {!rawKey && (
                <span className="text-muted-foreground text-xs">{t("api.keyMasked")}</span>
              )}
            </div>
            <Link to={API_KEYS_PAGE} className="text-primary text-xs hover:underline">
              {t("api.manageKeys")}
            </Link>
          </div>
        ))}

      {rawKey && (
        <Alert variant="success">
          <AlertDescription>{t("api.keyCreated")}</AlertDescription>
        </Alert>
      )}

      {!hasRequiredFile && (
        <Block title={curlMultipart ? `${t("api.curlTitle")} — JSON` : t("api.curlTitle")}>
          <CopyBlock value={buildCurlJson(request)} multiline />
        </Block>
      )}

      {curlMultipart && (
        <Block title={`${t("api.curlTitle")} — multipart/form-data`}>
          <CopyBlock value={curlMultipart} multiline />
        </Block>
      )}

      <Block title={t("api.responseTitle")}>
        <pre className="border-border bg-muted/50 overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs">
          {RUN_RESPONSE_EXAMPLE}
        </pre>
        <p className="text-muted-foreground text-xs">{t("api.responseHint")}</p>
      </Block>

      <a
        href="/api/docs"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
      >
        {t("api.docsLink")}
        <ExternalLink className="size-3.5" aria-hidden />
      </a>

      {showKeys && <ApiKeyCreateModal onKeyCreated={setRawKey} />}
    </div>
  );
}
