// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightOpen } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import type { EnrichedRun } from "@appstrate/shared-types";
import { LogViewer } from "../log-viewer";
import { Modal } from "../modal";
import type { ExecutionEntry, RunTurnRow } from "../log-utils";
import { RunSnapshotInspector } from "./run-snapshot-inspector";

export function RunExecutionView({
  run,
  logs,
  turns,
}: {
  run: EnrichedRun;
  logs: ExecutionEntry[];
  turns: RunTurnRow[];
}) {
  const { t } = useTranslation("agents");
  const [snapshotOpen, setSnapshotOpen] = useState(false);

  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3 lg:hidden">
        <div>
          <h2 className="font-semibold">{t("run.executionStream")}</h2>
          <p className="text-muted-foreground text-xs">{t("run.executionStreamHint")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setSnapshotOpen(true)}>
          <PanelRightOpen className="size-4" />
          {t("run.snapshotAction")}
        </Button>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
        <section className="min-w-0">
          <div className="mb-3 hidden lg:block">
            <h2 className="font-semibold">{t("run.executionStream")}</h2>
            <p className="text-muted-foreground text-xs">{t("run.executionStreamHint")}</p>
          </div>
          <LogViewer entries={logs} />
        </section>
        <aside className="border-border hidden min-w-0 border-l pl-5 lg:block">
          <RunSnapshotInspector run={run} turns={turns} />
        </aside>
      </div>

      <Modal
        open={snapshotOpen}
        onClose={() => setSnapshotOpen(false)}
        title={t("run.snapshotTitle")}
        className="h-[min(92vh,58rem)] max-w-2xl overflow-y-auto"
      >
        <RunSnapshotInspector run={run} turns={turns} showHeading={false} />
      </Modal>
    </div>
  );
}
