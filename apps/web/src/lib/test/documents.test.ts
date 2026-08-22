// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { File as FileIcon, FileArchive, FileCode, FileImage, FileText } from "lucide-react";
import {
  documentExpiryInfo,
  documentRunHref,
  featuredRunDocument,
  isImageMime,
  isMarkdownDoc,
  mimeIconFor,
  type DocumentLike,
} from "../documents.ts";

function doc(overrides: Partial<DocumentLike>): DocumentLike {
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

describe("documentRunHref", () => {
  it("builds the agent run route with literal scope slashes", () => {
    expect(documentRunHref(doc({ run_id: "run_1", packageId: "@acme/writer" }))).toBe(
      "/agents/@acme/writer/runs/run_1",
    );
  });

  it("returns undefined without a run or a package id", () => {
    expect(documentRunHref(doc({ run_id: null, packageId: "@acme/writer" }))).toBeUndefined();
    expect(documentRunHref(doc({ run_id: "run_1", packageId: null }))).toBeUndefined();
  });
});

describe("documentExpiryInfo", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const inDays = (d: number) => new Date(now + d * 24 * 60 * 60 * 1000).toISOString();
  const inHours = (h: number) => new Date(now + h * 60 * 60 * 1000).toISOString();

  it("returns null for a permanent or unparseable deadline", () => {
    expect(documentExpiryInfo(null, now)).toBeNull();
    expect(documentExpiryInfo("not-a-date", now)).toBeNull();
  });

  it("buckets a far-off deadline into whole days, not soon", () => {
    const info = documentExpiryInfo(inDays(30), now)!;
    expect(info.days).toBe(30);
    expect(info.soon).toBe(false);
    expect(info.expired).toBe(false);
  });

  it("flags a deadline within the 7-day window as soon", () => {
    const info = documentExpiryInfo(inDays(3), now)!;
    expect(info.days).toBe(3);
    expect(info.soon).toBe(true);
    expect(info.expired).toBe(false);
  });

  it("reports sub-day deadlines in hours", () => {
    const info = documentExpiryInfo(inHours(5), now)!;
    expect(info.days).toBe(0);
    expect(info.hours).toBe(5);
    expect(info.soon).toBe(true);
  });

  it("never reads '0h' for a still-valid sub-hour deadline", () => {
    const info = documentExpiryInfo(new Date(now + 10 * 60 * 1000).toISOString(), now)!;
    expect(info.days).toBe(0);
    expect(info.hours).toBe(1);
    expect(info.expired).toBe(false);
  });

  it("clamps a past deadline to zero and marks it expired", () => {
    const info = documentExpiryInfo(inDays(-2), now)!;
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

describe("isMarkdownDoc", () => {
  it("accepts an explicit text/markdown mime, with or without parameters", () => {
    expect(isMarkdownDoc("text/markdown", "notes")).toBe(true);
    expect(isMarkdownDoc("text/markdown; charset=utf-8", "notes")).toBe(true);
    expect(isMarkdownDoc("TEXT/MARKDOWN", "notes")).toBe(true);
  });

  it("accepts a .md file served with a text-ish mime (the preview route relabels markdown)", () => {
    // The server serves markdown as `text/plain` to defeat md→HTML sniffing, so
    // on that path the rich-render decision has to come from the name.
    expect(isMarkdownDoc("text/plain", "report.md")).toBe(true);
    expect(isMarkdownDoc("text/plain", "REPORT.MD")).toBe(true);
  });

  it("rejects a .md name under a non-text mime", () => {
    // A binary body named `.md` must not be routed through the HTML renderer.
    expect(isMarkdownDoc("application/octet-stream", "report.md")).toBe(false);
  });

  it("rejects plain text and other document kinds", () => {
    expect(isMarkdownDoc("text/plain", "notes.txt")).toBe(false);
    expect(isMarkdownDoc("text/html", "page.html")).toBe(false);
    expect(isMarkdownDoc("application/pdf", "doc.pdf")).toBe(false);
    expect(isMarkdownDoc("image/png", "shot.png")).toBe(false);
  });
});

/**
 * The derived presentation rule (#1177): the run page features a run's single
 * produced file, and features nothing at all otherwise.
 */
describe("featuredRunDocument", () => {
  const produced = (id: string) => ({ ...doc({ purpose: "agent_output", run_id: "run_1" }), id });
  const uploaded = (id: string) => ({ ...doc({ purpose: "user_upload", run_id: "run_1" }), id });

  it("features nothing when the run produced no file", () => {
    expect(featuredRunDocument([])).toBeUndefined();
    expect(featuredRunDocument([uploaded("doc_in_1"), uploaded("doc_in_2")])).toBeUndefined();
  });

  it("features the single produced file", () => {
    expect(featuredRunDocument([produced("doc_out")])?.id).toBe("doc_out");
  });

  it("features nothing when the run produced several files — they are just listed", () => {
    const three = [produced("doc_1"), produced("doc_2"), produced("doc_3")];
    expect(featuredRunDocument(three)).toBeUndefined();
  });

  it("never counts the files the run consumed as input", () => {
    // Two inputs + one output is still a single-file run, and one output among
    // several inputs stays the featured one.
    const mixed = [uploaded("doc_in_1"), produced("doc_out"), uploaded("doc_in_2")];
    expect(featuredRunDocument(mixed)?.id).toBe("doc_out");
    // Conversely, inputs never make up the "exactly one" count on their own.
    expect(featuredRunDocument([uploaded("doc_in_1")])).toBeUndefined();
  });
});
