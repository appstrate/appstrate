// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { JsonView } from "../json-view";
import { SectionCard } from "../section-card";
import { RunTrigger } from "../run-trigger";
import { SnapshotAccordionItem } from "./snapshot-accordion-item";

export function RunSourceCard({
  run,
  presentation = "card",
}: {
  run: EnrichedRun;
  presentation?: "card" | "accordion";
}) {
  const { t } = useTranslation("agents");
  const content = run.package_ephemeral ? (
    run.inline_prompt || run.inline_manifest ? (
      <div className="space-y-3">
        {run.inline_prompt && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">
              {t("run.sourcePrompt")}
            </p>
            <pre className="bg-muted/40 max-h-48 overflow-auto p-3 text-xs whitespace-pre-wrap">
              {run.inline_prompt}
            </pre>
          </div>
        )}
        {run.inline_manifest && (
          <div>
            <p className="text-muted-foreground mb-1 text-xs font-medium">
              {t("run.sourceManifest")}
            </p>
            <JsonView data={run.inline_manifest} />
          </div>
        )}
      </div>
    ) : (
      <p className="text-muted-foreground text-sm">{t("run.inlineSourceExpired")}</p>
    )
  ) : (
    <dl
      className={
        presentation === "accordion" ? "divide-border divide-y" : "grid gap-3 sm:grid-cols-2"
      }
    >
      <SourceFact
        label={t("run.sourceAgent")}
        value={[run.agent_scope, run.agent_name].filter(Boolean).join("/") || t("run.unknownValue")}
        plain={presentation === "accordion"}
      />
      <SourceFact
        label={t("run.infoVersion")}
        value={run.version_ref === "draft" ? t("run.draft") : `v${run.version_ref}`}
        plain={presentation === "accordion"}
      />
      {presentation === "accordion" && (
        <SourceFact label={t("run.infoTrigger")} value={<RunTrigger run={run} />} plain />
      )}
    </dl>
  );

  if (presentation === "accordion") {
    return (
      <SnapshotAccordionItem
        title={t("run.sourceTitle")}
        icon={Bot}
        summary={run.version_ref === "draft" ? t("run.draft") : `v${run.version_ref}`}
        defaultOpen
      >
        {content}
      </SnapshotAccordionItem>
    );
  }

  return <SectionCard title={t("run.sourceTitle")}>{content}</SectionCard>;
}

function SourceFact({
  label,
  value,
  plain = false,
}: {
  label: string;
  value: React.ReactNode;
  plain?: boolean;
}) {
  return (
    <div className={plain ? "py-2.5 first:pt-0 last:pb-0" : "bg-muted/30 rounded-lg border p-3"}>
      <p className="text-muted-foreground text-xs">{label}</p>
      <div
        className="mt-1 min-w-0 truncate text-sm font-medium"
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}
