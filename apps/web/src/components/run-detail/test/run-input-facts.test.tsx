// SPDX-License-Identifier: Apache-2.0

/**
 * The overview's Input card: which files it lists as the run's input, what it
 * says without `files:read` or under a capped page, and how it shows a value.
 *
 * Driven through `RunInputFacts`, fed an already-resolved file list.
 */

import { describe, it, expect } from "bun:test";
import type { EnrichedRun } from "@appstrate/shared-types";
import agentsFr from "../../../locales/fr/agents.json";
import filesFr from "../../../locales/fr/files.json";
import i18n, { i18nReady } from "../../../i18n.ts";
import type { FileDto } from "../../../hooks/use-files.ts";
import { fileFixture, render } from "../../../test/render.tsx";
import { makeRun } from "../../test/run-fixture.tsx";
import { RunInputFacts } from "../run-snapshot-inspector.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const RUN_ID = "run_1";

/** Uploaded as this run's input. */
const UPLOADED = fileFixture({ name: "brief.pdf", purpose: "user_upload", runId: RUN_ID });
/** An earlier run's output, chained into this one with `appfile://`. */
const CHAINED_IN = fileFixture({ name: "source.csv", runId: "run_0" });
/** What this run produced: never an input. */
const PRODUCED = fileFixture({ name: "rapport.md", runId: RUN_ID });

function facts(
  files: FileDto[],
  extra: {
    input?: Record<string, unknown>;
    inputCount?: number;
    hasMore?: boolean;
    filesDenied?: boolean;
  } = {},
): string {
  const run: EnrichedRun = makeRun({
    id: RUN_ID,
    input: extra.input ?? null,
    file_counts: { input: extra.inputCount ?? 0, output: 0 },
  });
  return render(
    <RunInputFacts
      run={run}
      files={files}
      hasMore={extra.hasMore ?? false}
      isLoading={false}
      error={null}
      filesDenied={extra.filesDenied ?? false}
    />,
  );
}

describe("the files the run consumed", () => {
  it("lists uploads and files chained in from an earlier run, never what the run produced", () => {
    const html = facts([UPLOADED, CHAINED_IN, PRODUCED], { inputCount: 2 });
    expect(html).toContain("brief.pdf");
    expect(html).toContain("source.csv");
    expect(html).not.toContain("rapport.md");
  });
});

describe("the input files without `files:read`", () => {
  it("names the missing access instead of saying the references are gone", () => {
    const html = facts([], { inputCount: 2, filesDenied: true });
    expect(html).toContain(filesFr["run.noAccess"]);
    expect(html).not.toContain(agentsFr["run.snapshotInputFilesUnavailable"]);
  });

  it("says the references are gone to a role that may list files", () => {
    const html = facts([], { inputCount: 2 });
    expect(html).toContain(agentsFr["run.snapshotInputFilesUnavailable"]);
    expect(html).not.toContain(filesFr["run.noAccess"]);
  });
});

describe("the input list says when it was cut", () => {
  it("shows the notice when input files fell off the page", () => {
    expect(facts([UPLOADED], { inputCount: 3, hasMore: true })).toContain(filesFr["run.truncated"]);
  });

  it("says nothing when the page held the whole container", () => {
    expect(facts([UPLOADED], { inputCount: 3 })).not.toContain(filesFr["run.truncated"]);
  });

  it("stays silent when the page was cut but every input is on screen", () => {
    const html = facts([UPLOADED, CHAINED_IN, PRODUCED], { inputCount: 2, hasMore: true });
    expect(html).not.toContain(filesFr["run.truncated"]);
  });
});

describe("an input value", () => {
  it("shows an array or an object as its payload, not as a count or a one-line string", () => {
    const html = facts([], { input: { recipients: ["ana@example.com", "bo@example.com"] } });
    expect(html).toContain("ana@example.com");
    expect(html).toContain("bo@example.com");
  });
});
