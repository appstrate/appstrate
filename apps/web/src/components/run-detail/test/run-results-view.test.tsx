// SPDX-License-Identifier: Apache-2.0

/**
 * What the Results tab says about the files a run produced: without
 * `files:read`, under a capped page, and for the single produced file.
 *
 * Driven through `RunResultsContent`, the view split from its fetch: the
 * decisions under test are all in the view.
 */

import { describe, it, expect } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import agentsFr from "../../../locales/fr/agents.json";
import filesFr from "../../../locales/fr/files.json";
import i18n, { i18nReady } from "../../../i18n.ts";
import type { FileDto } from "../../../hooks/use-files.ts";
import { fileFixture, render } from "../../../test/render.tsx";
import { makeRun } from "../../../test/run-fixture.ts";
import { RunResultsContent } from "../run-results-view.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const RUN_ID = "run_1";

function file(overrides: Partial<FileDto> & { name: string }): FileDto {
  return fileFixture({ runId: RUN_ID, ...overrides });
}

function results(
  files: FileDto[],
  extra: { producedCount?: number; hasMore?: boolean; filesDenied?: boolean } = {},
): string {
  const run: EnrichedRun = makeRun({
    id: RUN_ID,
    file_counts: { input: 0, output: extra.producedCount ?? files.length },
  });
  return render(
    <RunResultsContent
      run={run}
      packageId="@inline/reporter"
      output={null}
      hasRunMemory={false}
      isRunning={false}
      files={files}
      hasMore={extra.hasMore ?? false}
      isLoading={false}
      error={null}
      filesDenied={extra.filesDenied ?? false}
    />,
  );
}

describe("the produced files without `files:read`", () => {
  it("names the missing access instead of claiming there is no file", () => {
    const html = results([], { producedCount: 2, filesDenied: true });
    expect(html).toContain(filesFr["run.noAccess"]);
    expect(html).not.toContain(agentsFr["run.resultsNoFiles"]);
  });

  it("says there is no file to a role that may list them", () => {
    const html = results([], { producedCount: 2 });
    expect(html).toContain(agentsFr["run.resultsNoFiles"]);
    expect(html).not.toContain(filesFr["run.noAccess"]);
  });

  it("does not hold the featured-file slot it can never fill", () => {
    const html = results([], { producedCount: 1, filesDenied: true });
    expect(html).not.toContain(agentsFr["run.deliverableLabel"]);
  });
});

describe("the produced list says when it was cut", () => {
  const two = [file({ name: "rapport.md" }), file({ name: "annexe.md" })];

  it("shows the notice when produced files fell off the page", () => {
    expect(results(two, { hasMore: true, producedCount: 4 })).toContain(
      agentsFr["run.producedFilesTruncated"],
    );
  });

  it("says nothing when the page held the whole container", () => {
    expect(results(two, { producedCount: 4 })).not.toContain(
      agentsFr["run.producedFilesTruncated"],
    );
  });

  it("stays silent when the page was cut but every produced file is on screen", () => {
    // `hasMore` describes the whole container, inputs included.
    const inputs = Array.from({ length: 5 }, (_, i) =>
      file({ name: `entree-${i}.csv`, purpose: "user_upload", runId: null }),
    );
    const html = results([...two, ...inputs], { hasMore: true, producedCount: 2 });
    expect(html).toContain("rapport.md");
    expect(html).not.toContain(agentsFr["run.producedFilesTruncated"]);
  });
});

describe("the single produced file", () => {
  it("leads in its viewer and keeps its row, where download, keep and delete live", () => {
    const only = file({
      name: "rapport.md",
      capabilities: {
        visible: true,
        metadata: true,
        download: true,
        preview: false,
        keep: true,
        delete: true,
      },
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const html = results([only]);
    expect(html).toContain(agentsFr["run.deliverableLabel"]);
    expect(html).toContain(`aria-label="Plus d'actions pour rapport.md"`);
  });
});
