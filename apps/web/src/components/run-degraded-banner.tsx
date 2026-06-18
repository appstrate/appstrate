// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIntegrationDetail } from "../hooks/use-integrations";

/**
 * Safe-narrow `runs.metadata.degraded_integrations` (a `string[]` of
 * integration package ids stamped platform-side by `recordRunDegradedIntegration`
 * when the `/internal/.../refresh` call flags a connection on a terminal 401)
 * out of the untyped `run.metadata` blob.
 */
function parseDegradedIntegrations(metadata: unknown): string[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).degraded_integrations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

function DegradedIntegrationRow({ integrationId }: { integrationId: string }) {
  const { t } = useTranslation("common");
  const { data } = useIntegrationDetail(integrationId);
  const name = data?.manifest.display_name ?? integrationId;
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="font-medium">{name}</span>
      <Button asChild size="sm" variant="outline">
        <Link to={`/integrations/${integrationId}`}>{t("btn.reconnect")}</Link>
      </Button>
    </li>
  );
}

/**
 * Banner shown on the run-detail page when one or more integrations hit a
 * terminal auth failure (a 401 that survived the proxy's refresh+retry) during
 * the run. The run does not fail — the agent just lost a tool mid-run — so this
 * is the only place a FINISHED run surfaces the degradation to a user who
 * wasn't watching the live `connection_update` badge. Each row links to the
 * integration's page where the canonical reconnect flow lives.
 */
export function RunDegradedBanner({ metadata }: { metadata: unknown }) {
  const { t } = useTranslation("agents");
  const ids = parseDegradedIntegrations(metadata);
  if (ids.length === 0) return null;
  return (
    <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-500">
        <AlertTriangle className="size-4" />
        {t("run.degradedIntegrations.title")}
      </div>
      <p className="text-muted-foreground mt-1">{t("run.degradedIntegrations.message")}</p>
      <ul className="mt-2 space-y-1.5">
        {ids.map((id) => (
          <DegradedIntegrationRow key={id} integrationId={id} />
        ))}
      </ul>
    </div>
  );
}
