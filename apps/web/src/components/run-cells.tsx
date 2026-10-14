// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { FileInput, FileOutput } from "lucide-react";
import type { EnrichedRun } from "@appstrate/shared-types";
import { runErrorText } from "../lib/run-error";
import { summarizeRunOutput } from "../lib/run-output-summary";

/** What a run ended with: its error, else a readable line of its output, else a dash. */
export function RunResult({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation(["agents"]);
  if (run.error) {
    return (
      <span
        className="text-destructive relative z-10 truncate font-mono text-xs"
        title={runErrorText(run, t)}
      >
        {runErrorText(run, t)}
      </span>
    );
  }
  const summary = summarizeRunOutput(run.result);
  if (!summary) return <span className="text-muted-foreground/50">—</span>;
  const text =
    summary.kind === "text" ? summary.text : t("runs.resultFields", { count: summary.count });
  return (
    <span className="relative z-10 truncate text-xs" title={text}>
      {text}
    </span>
  );
}

export function DocumentCounts({ run }: { run: EnrichedRun }) {
  const { t } = useTranslation(["agents"]);
  const { input, output } = run.file_counts;
  if (!input && !output) return null;
  return (
    // `relative z-10`: these carry a `title`, and the row's link overlay would
    // otherwise take the hover with the click (see `data-table.tsx`).
    <span className="text-muted-foreground relative z-10 flex items-center gap-1.5 text-xs">
      {input > 0 && (
        <span className="flex items-center gap-0.5" title={t("run.inputFiles", { count: input })}>
          <FileInput size={12} className="shrink-0" />
          {input}
        </span>
      )}
      {output > 0 && (
        <span className="flex items-center gap-0.5" title={t("run.outputFiles", { count: output })}>
          <FileOutput size={12} className="shrink-0" />
          {output}
        </span>
      )}
    </span>
  );
}
