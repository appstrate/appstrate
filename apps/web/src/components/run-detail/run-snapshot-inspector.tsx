// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Braces,
  Coins,
  FileCode2,
  FileInput,
  ListTree,
  Plug,
  Settings2,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { formatDuration } from "@appstrate/core/format";
import { ACTIVE_RUN_STATUSES, type EnrichedRun, type TokenUsage } from "@appstrate/shared-types";
import { RunTurnsDetail } from "../run-info-tab";
import type { RunTurnRow } from "../log-utils";
import { RunCostReadout } from "../run-cost-readout";
import { Modal } from "../modal";
import { useDocuments } from "../../hooks/use-documents";
import { DocumentListPanel } from "../document-list-panel";
import { formatDateField } from "../../lib/markdown";
import { SnapshotAccordionItem } from "./snapshot-accordion-item";

export function RunSnapshotInspector({ run, turns }: { run: EnrichedRun; turns: RunTurnRow[] }) {
  const { t } = useTranslation("agents");
  const [turnsOpen, setTurnsOpen] = useState(false);
  const inputDocumentsQuery = useDocuments({
    runId: run.id,
    purpose: "user_upload",
    limit: 100,
  });
  const inputDocuments = inputDocumentsQuery.data?.data ?? [];
  const input = (run.input as Record<string, unknown> | null) ?? null;
  const inputEntries = input ? Object.entries(input) : [];
  const config = (run.config as Record<string, unknown> | null) ?? null;
  const metadata = (run.metadata as Record<string, unknown> | null) ?? null;
  const usage = run.token_usage as TokenUsage | null;
  const connections = run.connections_used ?? [];
  const isActive = (ACTIVE_RUN_STATUSES as ReadonlySet<string>).has(run.status);
  const agentExecuted =
    [run.agent_scope, run.agent_name].filter(Boolean).join("/") || t("run.unknownValue");

  return (
    <div data-run-snapshot>
      <SnapshotAccordionItem
        title={t("run.infoExecution")}
        icon={Activity}
        summary={run.version_ref === "draft" ? t("run.draft") : `v${run.version_ref}`}
        defaultOpen
      >
        <SnapshotFacts>
          <SnapshotFact label={t("run.sourceAgent")} value={agentExecuted} />
          {!run.package_ephemeral && (
            <SnapshotFact
              label={t("run.infoVersion")}
              value={run.version_ref === "draft" ? t("run.draft") : `v${run.version_ref}`}
            />
          )}
          <SnapshotFact
            label={t("run.infoTrigger")}
            value={formatSnapshotTrigger(run) ?? t("run.unknownValue")}
          />
          {run.started_at && (
            <SnapshotFact
              label={t("run.infoStartedAt")}
              value={formatDateField(run.started_at, "datetime")}
            />
          )}
          {run.completed_at && (
            <SnapshotFact
              label={t("run.infoCompletedAt")}
              value={formatDateField(run.completed_at, "datetime")}
            />
          )}
          {run.duration != null && (
            <SnapshotFact label={t("run.infoDuration")} value={formatDuration(run.duration)} />
          )}
          {run.proxy_label && <SnapshotFact label={t("run.infoProxy")} value={run.proxy_label} />}
        </SnapshotFacts>
      </SnapshotAccordionItem>

      <SnapshotAccordionItem
        title={t("run.infoInput")}
        icon={FileInput}
        summary={inputEntries.length + run.document_counts.input}
      >
        {inputEntries.length > 0 && (
          <div>
            <p className="text-muted-foreground mb-2 text-xs">{t("run.snapshotInputValues")}</p>
            <SnapshotFacts>
              {inputEntries.map(([key, value]) => (
                <SnapshotFact key={key} label={key} value={formatSnapshotValue(value)} />
              ))}
            </SnapshotFacts>
          </div>
        )}

        {(run.document_counts.input > 0 ||
          inputDocumentsQuery.isLoading ||
          Boolean(inputDocumentsQuery.error)) && (
          <div className={inputEntries.length > 0 ? "mt-4" : undefined}>
            <p className="text-muted-foreground mb-2 text-xs">{t("run.snapshotInputFiles")}</p>
            <DocumentListPanel
              documents={inputDocuments}
              isLoading={inputDocumentsQuery.isLoading}
              error={inputDocumentsQuery.error}
              empty={{ message: t("run.snapshotInputFilesUnavailable"), compact: true }}
              runId={run.id}
              showPurposeTabs={false}
              display="table"
              tableSurface="integrated"
              tableShowHeader={false}
            />
          </div>
        )}
      </SnapshotAccordionItem>

      <SnapshotAccordionItem
        title={t("run.infoUsage")}
        icon={Coins}
        headerRight={
          isActive ? (
            <span className="bg-primary/15 text-primary inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
              <span className="bg-primary size-1.5 animate-pulse rounded-full" aria-hidden />
              {t("run.usageLive")}
            </span>
          ) : null
        }
      >
        <SnapshotFacts>
          {(run.cost != null || run.cost_pricing_status != null) && (
            <SnapshotFact
              label={t("run.usageCost")}
              value={<RunCostReadout cost={run.cost} pricingStatus={run.cost_pricing_status} />}
            />
          )}
          {run.model_label && <SnapshotFact label={t("run.usageModel")} value={run.model_label} />}
          {usage?.input_tokens != null && (
            <SnapshotFact
              label={t("run.usageInputTokens")}
              value={usage.input_tokens.toLocaleString()}
            />
          )}
          {usage?.output_tokens != null && (
            <SnapshotFact
              label={t("run.usageOutputTokens")}
              value={usage.output_tokens.toLocaleString()}
            />
          )}
          {usage?.cache_creation_input_tokens != null && (
            <SnapshotFact
              label={t("run.usageCacheCreation")}
              value={usage.cache_creation_input_tokens.toLocaleString()}
            />
          )}
          {usage?.cache_read_input_tokens != null && (
            <SnapshotFact
              label={t("run.usageCacheRead")}
              value={usage.cache_read_input_tokens.toLocaleString()}
            />
          )}
        </SnapshotFacts>
        {turns.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 -ml-2"
            onClick={() => setTurnsOpen(true)}
          >
            <ListTree className="size-4" />
            {t("run.viewTurnDetails")}
          </Button>
        )}
      </SnapshotAccordionItem>

      {connections.length > 0 && (
        <SnapshotAccordionItem title={t("run.infoConnections")} icon={Plug}>
          <SnapshotFacts>
            {connections.map((connection) => (
              <SnapshotFact
                key={connection.integration_id}
                label={connection.integration_id}
                value={[
                  connection.label,
                  connection.account_id,
                  t(`run.connSource.${connection.source}`, { defaultValue: connection.source }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ))}
          </SnapshotFacts>
        </SnapshotAccordionItem>
      )}

      {config && Object.keys(config).length > 0 && (
        <SnapshotAccordionItem title={t("run.infoConfig")} icon={Settings2}>
          <SnapshotFacts>
            {Object.entries(config).map(([key, value]) => (
              <SnapshotFact key={key} label={key} value={formatSnapshotValue(value)} />
            ))}
          </SnapshotFacts>
        </SnapshotAccordionItem>
      )}

      {metadata && Object.keys(metadata).length > 0 && (
        <SnapshotAccordionItem title={t("run.infoMetadata")} icon={Braces}>
          <SnapshotFacts>
            {Object.entries(metadata).map(([key, value]) => (
              <SnapshotFact key={key} label={key} value={formatSnapshotValue(value)} />
            ))}
          </SnapshotFacts>
        </SnapshotAccordionItem>
      )}

      {run.package_ephemeral && (run.inline_prompt || run.inline_manifest) && (
        <SnapshotAccordionItem title={t("run.technicalDetails")} icon={FileCode2}>
          <SnapshotFacts>
            {run.inline_prompt && (
              <SnapshotFact label={t("run.tabPrompt")} value={run.inline_prompt} />
            )}
            {run.inline_manifest && (
              <SnapshotFact
                label={t("run.tabManifest")}
                value={JSON.stringify(run.inline_manifest, null, 2)}
              />
            )}
          </SnapshotFacts>
        </SnapshotAccordionItem>
      )}

      <Modal
        open={turnsOpen}
        onClose={() => setTurnsOpen(false)}
        title={t("run.turnsTitle")}
        className="max-h-[85vh] max-w-4xl overflow-y-auto"
      >
        <RunTurnsDetail turns={turns} />
      </Modal>
    </div>
  );
}

function SnapshotFacts({ children }: { children: React.ReactNode }) {
  return <dl className="grid gap-y-3">{children}</dl>;
}

function SnapshotFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground [&>span]:text-foreground mt-1 min-w-0 text-sm break-words whitespace-pre-wrap [&>span]:text-sm">
        {value}
      </dd>
    </div>
  );
}

function formatSnapshotTrigger(run: EnrichedRun): string | null {
  if (run.scheduleId) return run.schedule_name || run.scheduleId;
  if (run.end_user_name) return run.end_user_name;
  if (run.api_key_name) return run.api_key_name;
  if (run.runner_name) {
    return [run.runner_name, run.user_name].filter(Boolean).join(" · ");
  }
  return run.user_name;
}

function formatSnapshotValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) return "—";
  if (Array.isArray(value)) return String(value.length);
  return JSON.stringify(value);
}
