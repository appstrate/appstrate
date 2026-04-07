// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { cn } from "../lib/utils";
import { JsonView } from "./json-view";
import { SectionCard } from "./section-card";
import { EmptyState } from "./page-states";
import { ProviderStatusRow } from "./provider-status-row";
import { useProviders } from "../hooks/use-providers";
import type { Run, RunProviderSnapshot } from "@appstrate/shared-types";

interface RunInfoTabProps {
  run: Run;
}

function InfoCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="border-border bg-muted/30 rounded-lg border p-4">
      <p className="text-muted-foreground mb-1 text-xs">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}

export function RunInfoTab({ run }: RunInfoTabProps) {
  const { t } = useTranslation(["agents", "settings"]);
  const { data: providersData } = useProviders();
  const providerStatuses = run.providerStatuses as RunProviderSnapshot[] | null;
  const input = run.input as Record<string, unknown> | null;
  const usage = run.tokenUsage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
  const metadata = run.metadata as Record<string, unknown> | null;
  const hasUsage = run.cost != null || run.tokensUsed != null || run.modelLabel != null;
  const hasConfig = run.modelLabel != null || run.proxyLabel != null;

  return (
    <div className="space-y-4">
      {/* Version */}
      <InfoCard
        label="Version"
        value={
          <span className={cn("font-mono", !run.versionLabel && "italic")}>
            {run.versionLabel
              ? `v${run.versionLabel}${run.versionDirty ? ` ${t("exec.versionDirty")}` : ""}`
              : t("exec.draft")}
          </span>
        }
      />

      {/* Connections */}
      {providerStatuses && providerStatuses.length > 0 && (
        <SectionCard title={t("exec.infoConnections")}>
          <div className="space-y-1.5">
            {providerStatuses.map((svc) => {
              const providerMeta = providersData?.providers?.find((p) => p.id === svc.id);
              return (
                <ProviderStatusRow
                  key={svc.id}
                  id={svc.id}
                  status={svc.status}
                  source={svc.source}
                  profileName={svc.profileName}
                  profileOwnerName={svc.profileOwnerName}
                  scopesSufficient={svc.scopesSufficient}
                  displayName={providerMeta?.displayName ?? svc.id}
                  iconUrl={providerMeta?.iconUrl}
                />
              );
            })}
          </div>
        </SectionCard>
      )}

      {/* Input */}
      {input && Object.keys(input).length > 0 && (
        <SectionCard title={t("exec.infoInput")}>
          <JsonView data={input} />
        </SectionCard>
      )}

      {/* Configuration */}
      {hasConfig && (
        <SectionCard title={t("exec.infoConfiguration")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {run.modelLabel != null && (
              <InfoCard label={t("exec.usageModel")} value={run.modelLabel} />
            )}
            {run.proxyLabel != null && (
              <InfoCard label={t("exec.infoProxy")} value={run.proxyLabel} />
            )}
          </div>
        </SectionCard>
      )}

      {/* Usage */}
      {hasUsage ? (
        <SectionCard title={t("exec.infoUsage")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {run.cost != null && (
              <InfoCard label={t("exec.usageCost")} value={`$${run.cost.toFixed(4)}`} />
            )}
            {usage?.input_tokens != null && (
              <InfoCard
                label={t("exec.usageInputTokens")}
                value={usage.input_tokens.toLocaleString()}
              />
            )}
            {usage?.output_tokens != null && (
              <InfoCard
                label={t("exec.usageOutputTokens")}
                value={usage.output_tokens.toLocaleString()}
              />
            )}
            {usage?.cache_creation_input_tokens != null && (
              <InfoCard
                label={t("exec.usageCacheCreation")}
                value={usage.cache_creation_input_tokens.toLocaleString()}
              />
            )}
            {usage?.cache_read_input_tokens != null && (
              <InfoCard
                label={t("exec.usageCacheRead")}
                value={usage.cache_read_input_tokens.toLocaleString()}
              />
            )}
          </div>
        </SectionCard>
      ) : (
        <EmptyState message={t("exec.emptyUsage")} icon={Coins} compact />
      )}

      {/* Metadata */}
      {metadata && Object.keys(metadata).length > 0 && (
        <SectionCard title="Metadata">
          <JsonView data={metadata} />
        </SectionCard>
      )}
    </div>
  );
}
