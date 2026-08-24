// SPDX-License-Identifier: Apache-2.0

/**
 * The Fichiers pane's truncation notice.
 *
 * This tab calls itself the COMPLETE file view of a run, and it is the pane the
 * 100-row page actually cuts: it lists the whole container `hasMore` describes,
 * inputs included. It shipped with no notice at all while the Outcome card —
 * which lists a client-side SUBSET — carried one.
 *
 * Driven through `RunFilesView`, split from its fetch for the same reason
 * `RunOutcomeView` is: the decision under test is in the view, and going
 * through the container would mean standing up a query harness.
 *
 * Same no-DOM harness as `run-outcome-tab.test.tsx`.
 */

import type { ReactElement } from "react";
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import filesFr from "../../locales/fr/files.json";
import i18n, { i18nReady } from "../../i18n.ts";
import type { FileDto } from "../../hooks/use-files.ts";
import { RunFilesView } from "../run-files-tab.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const RUN_ID = "run_1";

function file(name: string): FileDto {
  return {
    id: `file_${name}`,
    purpose: "agent_output",
    run_id: RUN_ID,
    packageId: "@acme/reporter",
    mime: "text/plain",
    size: 12,
    createdAt: "2026-07-01T10:00:00.000Z",
    expiresAt: null,
    capabilities: { download: true, delete: false, keep: false },
  } as unknown as FileDto;
}

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

function filesTab(files: FileDto[], extra: { hasMore?: boolean } = {}): string {
  return render(
    <RunFilesView
      runId={RUN_ID}
      files={files}
      hasMore={extra.hasMore ?? false}
      isLoading={false}
      error={null}
    />,
  );
}

describe("the complete file view says when it is not complete", () => {
  it("shows the notice when the run's file page was capped", () => {
    expect(filesTab([file("rapport.md")], { hasMore: true })).toContain(filesFr["run.truncated"]);
  });

  it("says nothing when the page held the whole container", () => {
    expect(filesTab([file("rapport.md")])).not.toContain(filesFr["run.truncated"]);
  });

  it("keeps the notice on the pane that is actually cut", () => {
    // `hasMore` is a fact about the request, not about the direction filter:
    // the rows that fell off could be inputs, outputs, or both, so the notice
    // never depends on which files came back.
    expect(filesTab([], { hasMore: true })).toContain(filesFr["run.truncated"]);
  });
});
