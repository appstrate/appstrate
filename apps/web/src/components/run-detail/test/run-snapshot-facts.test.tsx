// SPDX-License-Identifier: Apache-2.0

/**
 * The overview's facts about a run: which definition it executed, the schedule
 * that fired it, its id, its token usage, its context occupancy, and an inline
 * run whose details compaction cleared.
 */

import { describe, it, expect } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import agentsFr from "../../../locales/fr/agents.json";
import i18n, { i18nReady } from "../../../i18n.ts";
import type { RunTurnRow } from "../../log-utils.ts";
import { render } from "../../../test/render.tsx";
import { makeRun } from "../../../test/run-fixture.ts";
import { RunSnapshotInspector } from "../run-snapshot-inspector.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

function overview(run: EnrichedRun, turns: RunTurnRow[] = []): string {
  return render(
    <RunSnapshotInspector
      run={run}
      turns={turns}
      logs={[]}
      structuredOutput={null}
      logsLoading={false}
      memoryChangeCount={0}
      memoryLoading={false}
      modelFallback={null}
      onOpenJournal={() => {}}
      onOpenResults={() => {}}
    />,
  );
}

const published = (over: Partial<EnrichedRun> = {}) =>
  makeRun({ package_ephemeral: false, version_ref: "1.2.0", ...over });

describe("RunSnapshotInspector — the run's facts", () => {
  it("names the published version a draft run was edited from", () => {
    const html = overview(published({ version_ref: "draft", version_label: "1.2.0" }));
    expect(html).toContain(`${agentsFr["run.draft"]} (v1.2.0 ${agentsFr["run.versionModified"]})`);
  });

  it("links the schedule that fired the run", () => {
    const html = overview(published({ scheduleId: "sch_1", schedule_name: "Rapport du lundi" }));
    expect(html).toContain('href="/schedules/sch_1"');
    expect(html).toContain("Rapport du lundi");
  });

  it("shows the run id", () => {
    const html = overview(published({ id: "run_abc" }));
    expect(html).toContain(agentsFr["run.infoRunId"]);
    expect(html).toContain("run_abc");
  });

  it("says an inline run's details expired once compaction cleared them", () => {
    const html = overview(makeRun({ inline_prompt: null, inline_manifest: null }));
    expect(html).toContain(agentsFr["runs.detailsExpired"]);
  });

  it("tells a never-measured usage from a measured zero", () => {
    // `token_usage` is NULL on a run that failed before reaching the model:
    // that is "never measured", not a confident 0.
    const never = overview(published({ status: "failed", token_usage: null }));
    expect(never).not.toContain(agentsFr["run.usageInputTokens"]);
    expect(never).not.toContain(agentsFr["run.usageOutputTokens"]);

    const measured = overview(
      published({
        status: "success",
        token_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    for (const label of [agentsFr["run.usageInputTokens"], agentsFr["run.usageOutputTokens"]]) {
      expect(measured).toMatch(new RegExp(`${label}</dt><dd[^>]*>0</dd>`));
    }
  });

  it("reads the context occupancy off the turns", () => {
    const turn: RunTurnRow = {
      index: 0,
      contextTokens: 187_000,
      contextWindow: 200_000,
      inputTokens: 187_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const html = overview(published({ status: "success" }), [turn]);
    expect(html).toContain(agentsFr["run.usageContext"]);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("187k / 200k");
  });
});
