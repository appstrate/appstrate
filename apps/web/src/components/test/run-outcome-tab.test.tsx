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

/**
 * The class `RunFeaturedFile` and its placeholder both put on the viewer box —
 * the marker for "the top slot is being held", with no text to read.
 */
const VIEWER_HEIGHT_CLASS = "h-[max(24rem,calc(100vh-28rem))]";

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

/**
 * A file an EARLIER run produced and this one merely consumed, chained in with
 * `appfile://`. `GET /api/files?run_id=…` returns it because the run's file
 * query answers the whole container (`run_id = X` OR an id referenced by
 * `runs.input`), and it keeps `purpose: "agent_output"` — the producing run's
 * purpose. Only its `run_id` tells it apart.
 */
const CHAINED_IN = file({ name: "source.csv", run_id: "run_0" });

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
  extra: {
    output?: Record<string, unknown> | null;
    memoryCount?: number;
    /** Overrides the run DTO's `file_counts.output` (defaults to the truth). */
    producedFileCount?: number;
    /** The list query reported rows beyond its page. */
    hasMore?: boolean;
    isLoading?: boolean;
    error?: unknown;
  } = {},
): string {
  return render(
    <RunOutcomeView
      runId={RUN_ID}
      packageId="@acme/reporter"
      output={extra.output ?? null}
      memoryCount={extra.memoryCount ?? 0}
      producedFileCount={
        extra.producedFileCount ??
        files.filter((f) => f.purpose === "agent_output" && f.run_id === RUN_ID).length
      }
      files={files}
      hasMore={extra.hasMore ?? false}
      isLoading={extra.isLoading ?? false}
      error={extra.error ?? null}
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

  it("does not flash a Fichiers card while the list loads on a run that produced none", () => {
    // The card's presence is decided by the run DTO's own count, not by the
    // query's phase: painting it during `isLoading` made every run with an
    // `output` value and no file jump as the card appeared and left again.
    const html = outcome([], { output: { verdict: "ok" }, producedFileCount: 0, isLoading: true });
    expect(html).not.toContain(agentsFr["run.sectionProducedFiles"]);
    expect(html).toContain(agentsFr["run.sectionOutput"]);
  });

  it("does not leave a permanent empty Fichiers card when the list request fails", () => {
    const html = outcome([], {
      output: { verdict: "ok" },
      producedFileCount: 0,
      error: new Error("boom"),
    });
    expect(html).not.toContain(agentsFr["run.sectionProducedFiles"]);
  });

  it("shows a file that landed while the page was open, under a stale count of 0", () => {
    // `producedFileCount` rides the run DTO; the list is invalidated by the
    // SSE `file.published` frame and can therefore hold a file the cached
    // count does not know about yet. Without the `|| produced.length > 0`
    // clause the card — and the file in it — would stay hidden until the run
    // resource refetched.
    const html = outcome([file({ name: "rapport.md" })], { producedFileCount: 0 });
    // A single produced file arrives HOISTED (no card at all) — but it arrives.
    expect(html).toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
    expect(html).toContain("rapport.md");
    expect(html).not.toContain(agentsFr["run.outcomeEmpty"]);
  });

  it("says so when the file page was truncated, instead of showing a short list", () => {
    // `GET /api/files` clamps `limit` to 100 and answers `hasMore`; discarding
    // it truncated a >100-file run with nothing on screen saying so.
    // Several files, because that is the only shape the notice can occur in: a
    // truncated page holds at least 100 rows, never the exactly-1 that hoists
    // the viewer and drops the card the notice hangs off.
    const many = [file({ name: "rapport.md" }), file({ name: "annexe.md" })];
    expect(outcome(many, { hasMore: true })).toContain(agentsFr["run.producedFilesTruncated"]);
    expect(outcome(many)).not.toContain(agentsFr["run.producedFilesTruncated"]);
  });

  it("still shows the card while loading when the run DID produce files", () => {
    // The count says there is something to wait for, so the section is there
    // from the first paint and the list fills in underneath it.
    const html = outcome([], { producedFileCount: 2, isLoading: true });
    expect(html).toContain(agentsFr["run.sectionProducedFiles"]);
  });

  it("offers no purpose filter — the pane is one purpose by construction", () => {
    // The several-files shape: the one that renders a FileListPanel at all.
    const html = outcome([UPLOAD, file({ name: "rapport.md" }), file({ name: "annexe.md" })]);
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

  it("never features — or even lists — a file another run produced", () => {
    // The `agent_output` purpose alone is not ownership: a chained-in file
    // carries it while belonging to the run that made it. Featuring it here
    // would show, and auto-preview, a file this run never produced.
    const chainedOnly = outcome([CHAINED_IN]);
    expect(chainedOnly).not.toContain("source.csv");
    expect(chainedOnly).not.toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
    expect(chainedOnly).toContain(agentsFr["run.outcomeEmpty"]);

    // One consumed + one produced is a SINGLE-file run: the produced one is
    // featured, and the two of them never read as "several, so feature none".
    const mixed = outcome([CHAINED_IN, file({ name: "rapport.md" })]);
    expect(mixed).toContain("rapport.md");
    expect(mixed).not.toContain("source.csv");
    expect(mixed).toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
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

describe("what the run produced LEADS the pane", () => {
  /** Where a marker sits in the rendered pane, asserted to be present. */
  function at(html: string, marker: string): number {
    const index = html.indexOf(marker);
    expect(index).toBeGreaterThan(-1);
    return index;
  }

  it("puts the single produced file above Output, and in no card", () => {
    // The file is what the run is FOR; the `output` tool's JSON is metadata
    // about it. And one file under a "Fichiers produits" title would be listed
    // as a single row directly beneath a full-size preview of itself.
    const html = outcome([file({ name: "rapport.md" })], { output: { verdict: "ok" } });
    expect(at(html, `aria-label="${filesFr["run.featuredLabel"]}"`)).toBeLessThan(
      at(html, agentsFr["run.sectionOutput"]),
    );
    expect(html).not.toContain(agentsFr["run.sectionProducedFiles"]);
  });

  it("puts the files card above Output when the run produced SEVERAL", () => {
    const html = outcome([file({ name: "rapport.md" }), file({ name: "annexe.md" })], {
      output: { verdict: "ok" },
    });
    expect(at(html, agentsFr["run.sectionProducedFiles"])).toBeLessThan(
      at(html, agentsFr["run.sectionOutput"]),
    );
    // Several are only listed — the pane never picks one for the user.
    expect(html).not.toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
  });

  it("leaves Output leading when the run produced no file at all", () => {
    const html = outcome([], { output: { verdict: "ok" }, memoryCount: 2 });
    expect(html).not.toContain(agentsFr["run.sectionProducedFiles"]);
    expect(at(html, agentsFr["run.sectionOutput"])).toBeLessThan(
      at(html, agentsFr["run.sectionMemory"]),
    );
  });

  it("holds the top slot while the list loads on a single-file run", () => {
    // `producedFileCount` is known on the first paint, `featured` only once
    // /api/files answers. Painting the card in that window and swapping it for
    // the hoisted viewer would be a layout jump on every open — the same class
    // of bug the `hasFiles` count already fixed once.
    const html = outcome([], { producedFileCount: 1, isLoading: true, output: { verdict: "ok" } });
    expect(html).not.toContain(agentsFr["run.sectionProducedFiles"]);
    // The placeholder reserves the viewer's exact footprint, above Output.
    expect(at(html, VIEWER_HEIGHT_CLASS)).toBeLessThan(at(html, agentsFr["run.sectionOutput"]));
  });

  it("believes the resolved list over a stale count that disagrees", () => {
    // Count says 1, the page holds three: the rows are the honest ones, so the
    // pane shows the list rather than featuring an arbitrary one of them.
    const three = ["a.md", "b.md", "c.md"].map((name) => file({ name }));
    const html = outcome(three, { producedFileCount: 1 });
    expect(html).toContain(agentsFr["run.sectionProducedFiles"]);
    expect(html).not.toContain(`aria-label="${filesFr["run.featuredLabel"]}"`);
  });
});
