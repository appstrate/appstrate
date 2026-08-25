// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import type { EnrichedRun } from "@appstrate/shared-types";
import { JsonView } from "../json-view";
import { SectionCard } from "../section-card";

export function RunSourceCard({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation("agents");

  return (
    <SectionCard title={t("run.sourceTitle")}>
      {run.package_ephemeral ? (
        run.inline_prompt || run.inline_manifest ? (
          <div className="space-y-3">
            {run.inline_prompt && (
              <div>
                <p className="text-muted-foreground mb-1 text-xs font-medium">
                  {t("run.sourcePrompt")}
                </p>
                <pre className="bg-muted/40 max-h-48 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">
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
        <div className="grid gap-3 sm:grid-cols-2">
          <SourceFact
            label={t("run.sourceAgent")}
            value={
              [run.agent_scope, run.agent_name].filter(Boolean).join("/") || t("run.unknownValue")
            }
          />
          <SourceFact
            label={t("run.infoVersion")}
            value={run.version_ref === "draft" ? t("run.draft") : `v${run.version_ref}`}
          />
        </div>
      )}
    </SectionCard>
  );
}

function SourceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/30 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 truncate text-sm font-medium" title={value}>
        {value}
      </p>
    </div>
  );
}
