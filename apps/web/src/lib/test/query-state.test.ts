// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  generatedKeyPackage,
  isQueryInFlight,
  keepPreviousWithin,
  versionKeyPackage,
} from "../query-state";
import { versionKeys } from "../query-keys";

describe("isQueryInFlight", () => {
  it("is true while fetching without data", () => {
    expect(isQueryInFlight({ isPending: true, fetchStatus: "fetching" })).toBe(true);
  });

  it("is true while a retry is paused (background tab): pending and not idle is still loading", () => {
    expect(isQueryInFlight({ isPending: true, fetchStatus: "paused" })).toBe(true);
  });

  it("is false for a disabled query, which is pending but idle", () => {
    expect(isQueryInFlight({ isPending: true, fetchStatus: "idle" })).toBe(false);
  });

  it("is false once the query has settled, refetching or not", () => {
    expect(isQueryInFlight({ isPending: false, fetchStatus: "idle" })).toBe(false);
    expect(isQueryInFlight({ isPending: false, fetchStatus: "fetching" })).toBe(false);
  });
});

const fileKey = (pkg: { scope: string; name: string }, path: string) =>
  [
    "get",
    "/api/packages/{scope}/{name}/files/content",
    { params: { path: pkg, query: { path } } },
  ] as const;

describe("generatedKeyPackage / versionKeyPackage", () => {
  it("name the package a key reads, whatever the file or version", () => {
    const pkg = { scope: "@acme", name: "mail" };
    expect(generatedKeyPackage(fileKey(pkg, "a.md"))).toBe("@acme/mail");
    expect(generatedKeyPackage(["agents", "x"])).toBeUndefined();
    expect(versionKeyPackage(versionKeys.detail("o", "s", "agent", "@a/b", "1.0.0"))).toBe(
      "agent/@a/b",
    );
    expect(versionKeyPackage(versionKeys.detail("o", "s", "agent", "@a/b", "1.1.0"))).toBe(
      "agent/@a/b",
    );
  });
});

describe("keepPreviousWithin", () => {
  const pkgA = { scope: "@acme", name: "mail" };
  const pkgB = { scope: "@acme", name: "other" };
  const options = (key: readonly unknown[], current: string) => ({
    queryKey: key,
    queryFn: async () => "new",
    placeholderData: keepPreviousWithin(current, generatedKeyPackage),
  });

  it("keeps the previous result for another file of the same package", () => {
    const qc = new QueryClient();
    qc.setQueryData(fileKey(pkgA, "a.md"), "content of a");
    const observer = new QueryObserver(qc, options(fileKey(pkgA, "a.md"), "@acme/mail"));
    const next = observer.getOptimisticResult(
      qc.defaultQueryOptions(options(fileKey(pkgA, "b.md"), "@acme/mail")),
    );
    expect(next.data).toBe("content of a");
    expect(next.isPlaceholderData).toBe(true);
    expect(next.isPending).toBe(false);
  });

  it("never shows another package's result", () => {
    const qc = new QueryClient();
    qc.setQueryData(fileKey(pkgA, "a.md"), "content of a");
    const observer = new QueryObserver(qc, options(fileKey(pkgA, "a.md"), "@acme/mail"));
    const next = observer.getOptimisticResult(
      qc.defaultQueryOptions(options(fileKey(pkgB, "a.md"), "@acme/other")),
    );
    expect(next.data).toBeUndefined();
    expect(next.isPending).toBe(true);
  });

  it("keeps nothing without a current package", () => {
    expect(keepPreviousWithin(undefined, generatedKeyPackage)("x", { queryKey: [] })).toBe(
      undefined,
    );
  });
});
