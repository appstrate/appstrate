// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { File as FileIcon, FileArchive, FileCode, FileImage, FileText } from "lucide-react";
import {
  documentExpiryInfo,
  documentRunHref,
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
