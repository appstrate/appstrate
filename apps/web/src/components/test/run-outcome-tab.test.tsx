// SPDX-License-Identifier: Apache-2.0

/**
 * What the Outcome pane shows (#1177 phase 3).
 *
 * Driven through `RunOutcomeView`, the pane split from its fetch: the decisions
 * under test — which sections appear, and which files reach the list — are all
 * in the view, and going through the container would mean standing up a query
 * harness to assert something it does not decide.
 *
 * Same no-DOM harness as `run-row.test.tsx`, plus a `QueryClientProvider`:
 * `FileListPanel` wires the delete/keep mutations on mount (they do not fire,
 * but they need the client) and `MemoryPanel` reads its rows through one.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import agentsFr from "../../locales/fr/agents.json";
import filesFr from "../../locales/fr/files.json";
import i18n, { i18nReady } from "../../i18n.ts";
import type { FileDto } from "../../hooks/use-files.ts";
import { RunOutcomeView } from "../run-outcome-tab.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const RUN_ID = "run_1";

function file(overrides: Partial<FileDto> & { name: string }): FileDto {
  return {
    id: `doc_${overrides.name}`,
    purpose: "agent_output",
    run_id: RUN_ID,
    packageId: "@acme/reporter",
    mime: "text/plain",
    size: 12,
    createdAt: "2026-07-01T10:00:00.000Z",
    expiresAt: null,
    capabilities: { download: true, delete: false, keep: false },
    ...overrides,
  } as unknown as FileDto;
}

/** One file the run consumed — never part of the outcome. */
const UPLOAD = file({ name: "brief.pdf", purpose: "user_upload", run_id: null });

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>{node}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

function outcome(
  files: FileDto[],
  extra: { output?: Record<string, unknown> | null; memoryCount?: number } = {},
): string {
  return render(
    <RunOutcomeView
      runId={RUN_ID}
      packageId="@acme/reporter"
      output={extra.output ?? null}
      memoryCount={extra.memoryCount ?? 0}
      files={files}
      isLoading={false}
      error={null}
    />,
  );
}

describe("Outcome shows what the run PRODUCED, and only that", () => {
  it("lists the produced files and leaves the uploads to the Fichiers tab", () => {
    const html = outcome([UPLOAD, file({ name: "rapport.md" }), file({ name: "annexe.md" })]);
    expect(html).toContain("rapport.md");
    expect(html).toContain("annexe.md");
    expect(html).not.toContain("brief.pdf");
  });

  it("shows nothing at all for a run whose only files were uploads", () => {
    // Not an empty "Fichiers produits" card: the run produced nothing, and the
    // uploads it consumed belong to the other pane.
    const html = outcome([UPLOAD]);
    expect(html).toContain(agentsFr["run.outcomeEmpty"]);
    expect(html).not.toContain(agentsFr["run.sectionProducedFiles"]);
    expect(html).not.toContain("brief.pdf");
  });

  it("offers no purpose filter — the pane is one purpose by construction", () => {
    const html = outcome([UPLOAD, file({ name: "rapport.md" })]);
    expect(html).not.toContain(filesFr["filter.user_upload"]);
    expect(html).not.toContain(filesFr["filter.all"]);
  });
});

describe("the derived presentation rule inside Outcome (#1177)", () => {
  it("features the file when the run produced exactly ONE", () => {
    const html = outcome([UPLOAD, file({ name: "rapport.md" })]);
    expect(html).toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
  });

  it("features nothing when the run produced SEVERAL — the user picks", () => {
    const html = outcome([file({ name: "rapport.md" }), file({ name: "annexe.md" })]);
    expect(html).not.toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
  });

  it("counts produced files only — a lone upload never makes a run single-file", () => {
    const html = outcome([UPLOAD]);
    expect(html).not.toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
  });
});

describe("the other two outcome sections", () => {
  it("names the `output` tool's value after the tool, not «Résultat»", () => {
    const html = outcome([], { output: { verdict: "ok" } });
    expect(html).toContain(agentsFr["run.sectionOutput"]);
    expect(html).toContain("verdict");
    expect(html).not.toContain(agentsFr["run.outcomeEmpty"]);
  });

  it("gives memory a visible identity only when the run actually wrote some", () => {
    // The common case is a run that wrote none; a permanently-empty «Mémoire»
    // card on every page is how a reader learns to skip the whole pane.
    expect(outcome([], { output: { verdict: "ok" } })).not.toContain(agentsFr["run.sectionMemory"]);
    const withMemory = outcome([], { memoryCount: 3 });
    expect(withMemory).toContain(agentsFr["run.sectionMemory"]);
    expect(withMemory).toContain(">3<");
  });

  it("says the run produced nothing rather than stacking three empty cards", () => {
    const html = outcome([]);
    expect(html).toContain(agentsFr["run.outcomeEmpty"]);
    expect(html).toContain(agentsFr["run.outcomeEmptyHint"]);
    expect(html).not.toContain(agentsFr["run.sectionOutput"]);
    expect(html).not.toContain(agentsFr["run.sectionProducedFiles"]);
    expect(html).not.toContain(agentsFr["run.sectionMemory"]);
  });
});
