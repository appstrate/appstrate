// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { File as FileIcon, FileArchive, FileCode, FileImage, FileText } from "lucide-react";
import {
  fileExpiryInfo,
  fileRunHref,
  featuredRunFile,
  producedRunFiles,
  isImageMime,
  isMarkdownFile,
  isPublishedFileLogEvent,
  mimeIconFor,
  type FileLike,
} from "../files.ts";

function file(overrides: Partial<FileLike>): FileLike {
  return {
    purpose: "agent_output",
    run_id: null,
    packageId: null,
    mime: "application/octet-stream",
    ...overrides,
  };
}

describe("mimeIconFor", () => {
  it("maps common families", () => {
    expect(mimeIconFor("image/png")).toBe(FileImage);
    expect(mimeIconFor("text/html")).toBe(FileCode);
    expect(mimeIconFor("application/json")).toBe(FileCode);
    expect(mimeIconFor("application/zip")).toBe(FileArchive);
    expect(mimeIconFor("text/plain")).toBe(FileText);
    expect(mimeIconFor("application/pdf")).toBe(FileText);
  });

  it("falls back to the neutral file icon", () => {
    expect(mimeIconFor("application/octet-stream")).toBe(FileIcon);
    expect(mimeIconFor("")).toBe(FileIcon);
  });
});

describe("fileRunHref", () => {
  it("builds the agent run route with literal scope slashes", () => {
    expect(fileRunHref(file({ run_id: "run_1", packageId: "@acme/writer" }))).toBe(
      "/agents/@acme/writer/runs/run_1",
    );
  });

  it("returns undefined without a run or a package id", () => {
    expect(fileRunHref(file({ run_id: null, packageId: "@acme/writer" }))).toBeUndefined();
    expect(fileRunHref(file({ run_id: "run_1", packageId: null }))).toBeUndefined();
  });
});

describe("fileExpiryInfo", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const inDays = (d: number) => new Date(now + d * 24 * 60 * 60 * 1000).toISOString();
  const inHours = (h: number) => new Date(now + h * 60 * 60 * 1000).toISOString();

  it("returns null for a permanent or unparseable deadline", () => {
    expect(fileExpiryInfo(null, now)).toBeNull();
    expect(fileExpiryInfo("not-a-date", now)).toBeNull();
  });

  it("buckets a far-off deadline into whole days, not soon", () => {
    const info = fileExpiryInfo(inDays(30), now)!;
    expect(info.days).toBe(30);
    expect(info.soon).toBe(false);
    expect(info.expired).toBe(false);
  });

  it("flags a deadline within the 7-day window as soon", () => {
    const info = fileExpiryInfo(inDays(3), now)!;
    expect(info.days).toBe(3);
    expect(info.soon).toBe(true);
    expect(info.expired).toBe(false);
  });

  it("reports sub-day deadlines in hours", () => {
    const info = fileExpiryInfo(inHours(5), now)!;
    expect(info.days).toBe(0);
    expect(info.hours).toBe(5);
    expect(info.soon).toBe(true);
  });

  it("never reads '0h' for a still-valid sub-hour deadline", () => {
    const info = fileExpiryInfo(new Date(now + 10 * 60 * 1000).toISOString(), now)!;
    expect(info.days).toBe(0);
    expect(info.hours).toBe(1);
    expect(info.expired).toBe(false);
  });

  it("clamps a past deadline to zero and marks it expired", () => {
    const info = fileExpiryInfo(inDays(-2), now)!;
    expect(info.days).toBe(0);
    expect(info.hours).toBe(0);
    expect(info.soon).toBe(true);
    expect(info.expired).toBe(true);
  });
});

describe("isImageMime", () => {
  it("is true only for an image/* mime", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("image/svg+xml")).toBe(true);
    expect(isImageMime("text/plain")).toBe(false);
    expect(isImageMime(null)).toBe(false);
    expect(isImageMime(undefined)).toBe(false);
    expect(isImageMime("")).toBe(false);
  });
});

describe("isMarkdownFile", () => {
  it("accepts an explicit text/markdown mime, with or without parameters", () => {
    expect(isMarkdownFile("text/markdown", "notes")).toBe(true);
    expect(isMarkdownFile("text/markdown; charset=utf-8", "notes")).toBe(true);
    expect(isMarkdownFile("TEXT/MARKDOWN", "notes")).toBe(true);
  });

  it("accepts a .md file served with a text-ish mime (the preview route relabels markdown)", () => {
    // The server serves markdown as `text/plain` to defeat md→HTML sniffing, so
    // on that path the rich-render decision has to come from the name.
    expect(isMarkdownFile("text/plain", "report.md")).toBe(true);
    expect(isMarkdownFile("text/plain", "REPORT.MD")).toBe(true);
  });

  it("rejects a .md name under a non-text mime", () => {
    // A binary body named `.md` must not be routed through the HTML renderer.
    expect(isMarkdownFile("application/octet-stream", "report.md")).toBe(false);
  });

  it("rejects plain text and other file kinds", () => {
    expect(isMarkdownFile("text/plain", "notes.txt")).toBe(false);
    expect(isMarkdownFile("text/html", "page.html")).toBe(false);
    expect(isMarkdownFile("application/pdf", "file.pdf")).toBe(false);
    expect(isMarkdownFile("image/png", "shot.png")).toBe(false);
  });
});

/**
 * The derived presentation rule (#1177): the run page features a run's single
 * produced file, and features nothing at all otherwise.
 */
describe("featuredRunFile", () => {
  const produced = (id: string) => ({ ...file({ purpose: "agent_output", run_id: "run_1" }), id });
  const uploaded = (id: string) => ({ ...file({ purpose: "user_upload", run_id: "run_1" }), id });

  it("features nothing when the run produced no file", () => {
    expect(featuredRunFile([])).toBeUndefined();
    expect(featuredRunFile([uploaded("doc_in_1"), uploaded("doc_in_2")])).toBeUndefined();
  });

  it("features the single produced file", () => {
    expect(featuredRunFile([produced("doc_out")])?.id).toBe("doc_out");
  });

  it("features nothing when the run produced several files — they are just listed", () => {
    const three = [produced("doc_1"), produced("doc_2"), produced("doc_3")];
    expect(featuredRunFile(three)).toBeUndefined();
  });

  it("never counts the files the run consumed as input", () => {
    // Two inputs + one output is still a single-file run, and one output among
    // several inputs stays the featured one.
    const mixed = [uploaded("doc_in_1"), produced("doc_out"), uploaded("doc_in_2")];
    expect(featuredRunFile(mixed)?.id).toBe("doc_out");
    // Conversely, inputs never make up the "exactly one" count on their own.
    expect(featuredRunFile([uploaded("doc_in_1")])).toBeUndefined();
  });
});

/**
 * What the Outcome pane lists. The Fichiers tab shows imported AND produced
 * files; Outcome shows only what the run PRODUCED, and this is the single
 * place that distinction is made.
 */
describe("producedRunFiles", () => {
  const produced = (id: string) => ({ ...file({ purpose: "agent_output", run_id: "run_1" }), id });
  const uploaded = (id: string) => ({ ...file({ purpose: "user_upload", run_id: "run_1" }), id });

  it("keeps the produced files, in order, and drops every upload", () => {
    const mixed = [
      uploaded("doc_in_1"),
      produced("doc_1"),
      uploaded("doc_in_2"),
      produced("doc_2"),
    ];
    expect(producedRunFiles(mixed).map((f) => f.id)).toEqual(["doc_1", "doc_2"]);
  });

  it("returns nothing for a run whose only files were uploads", () => {
    expect(producedRunFiles([uploaded("doc_in_1"), uploaded("doc_in_2")])).toEqual([]);
    expect(producedRunFiles([])).toEqual([]);
  });

  it("is what the featured rule counts, so the two cannot disagree", () => {
    const one = [uploaded("doc_in_1"), produced("doc_out")];
    expect(producedRunFiles(one)).toHaveLength(1);
    expect(featuredRunFile(one)?.id).toBe("doc_out");
  });
});

/**
 * The run page refreshes its file list off the run's live log stream. The tag
 * it matches on was renamed by #1177, but the emitter (API + runtime image)
 * deploys on its own clock — a version-skewed emitter still sends the old tag,
 * and a reader that only knows the new one leaves the list silently stale.
 */
describe("isPublishedFileLogEvent", () => {
  it("accepts the current tag", () => {
    expect(isPublishedFileLogEvent("file")).toBe(true);
  });

  it("still accepts the pre-#1177 `document` tag", () => {
    expect(isPublishedFileLogEvent("document")).toBe(true);
  });

  it("rejects every other run-log event, and the empty cases", () => {
    for (const other of ["log", "progress", "output", "input", "run_completed", "report", ""]) {
      expect(isPublishedFileLogEvent(other)).toBe(false);
    }
    expect(isPublishedFileLogEvent(null)).toBe(false);
    expect(isPublishedFileLogEvent(undefined)).toBe(false);
  });
});
