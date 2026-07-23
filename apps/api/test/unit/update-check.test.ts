// SPDX-License-Identifier: Apache-2.0

// Pure-logic tests for the update-availability check (#694): semver
// comparison and the TTL/single-flight cache. No network, no DB — the
// GitHub fetch and the clock are injected.

import { describe, it, expect } from "bun:test";
import { isNewerVersion, UpdateChecker } from "../../src/services/update-check.ts";

describe("isNewerVersion", () => {
  it("detects a newer patch release", () => {
    expect(isNewerVersion("1.0.0", "1.0.1")).toBe(true);
  });

  it("returns false for equal versions", () => {
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns false when latest is older", () => {
    expect(isNewerVersion("1.2.3", "1.2.2")).toBe(false);
  });

  it("orders prerelease identifiers numerically (beta.38 < beta.39)", () => {
    expect(isNewerVersion("1.0.0-beta.38", "1.0.0-beta.39")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.39", "1.0.0-beta.38")).toBe(false);
    // Not lexicographic: beta.9 < beta.10
    expect(isNewerVersion("1.0.0-beta.9", "1.0.0-beta.10")).toBe(true);
  });

  it("ranks a stable release above its prereleases", () => {
    expect(isNewerVersion("1.0.0-beta.38", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.1-beta.1")).toBe(true);
  });

  it("tolerates v prefixes and build metadata", () => {
    expect(isNewerVersion("v1.0.0", "v1.1.0")).toBe(true);
    expect(isNewerVersion("1.0.0+build.1", "1.0.0+build.2")).toBe(false);
  });

  it("returns false on invalid input (never nags on garbage)", () => {
    expect(isNewerVersion("dev", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "not-a-version")).toBe(false);
    expect(isNewerVersion("", "")).toBe(false);
  });
});

function makeChecker(opts: {
  currentVersion?: string | null;
  enabled?: boolean;
  results: Array<string | Error>;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
}) {
  let calls = 0;
  const checker = new UpdateChecker({
    currentVersion: opts.currentVersion === undefined ? "1.0.0" : opts.currentVersion,
    enabled: opts.enabled ?? true,
    now: opts.now,
    successTtlMs: opts.successTtlMs,
    failureTtlMs: opts.failureTtlMs,
    fetchLatest: () => {
      const result = opts.results[Math.min(calls, opts.results.length - 1)]!;
      calls++;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  });
  return { checker, fetchCalls: () => calls };
}

describe("UpdateChecker", () => {
  it("reports an available update when GitHub has a newer release", async () => {
    const { checker } = makeChecker({
      currentVersion: "1.0.0-beta.38",
      results: ["1.0.0-beta.40"],
    });
    const status = await checker.getStatus();
    expect(status).toEqual({
      check_enabled: true,
      update_available: true,
      latest_version: "1.0.0-beta.40",
      checked_at: expect.any(String) as unknown as string,
    });
  });

  it("reports no update when already on the latest release", async () => {
    const { checker } = makeChecker({ currentVersion: "1.0.0", results: ["1.0.0"] });
    const status = await checker.getStatus();
    expect(status.update_available).toBe(false);
    expect(status.latest_version).toBe("1.0.0");
  });

  it("never fetches when disabled via env", async () => {
    const { checker, fetchCalls } = makeChecker({ enabled: false, results: ["9.9.9"] });
    const status = await checker.getStatus();
    expect(status).toEqual({
      check_enabled: false,
      update_available: false,
      latest_version: null,
      checked_at: null,
    });
    expect(fetchCalls()).toBe(0);
  });

  it("never fetches when the running version is unknown (dev)", async () => {
    const { checker, fetchCalls } = makeChecker({ currentVersion: null, results: ["9.9.9"] });
    const status = await checker.getStatus();
    expect(status.check_enabled).toBe(false);
    expect(fetchCalls()).toBe(0);
  });

  it("caches the result within the success TTL", async () => {
    let t = 1_000_000;
    const { checker, fetchCalls } = makeChecker({
      results: ["2.0.0"],
      now: () => t,
      successTtlMs: 10_000,
    });
    await checker.getStatus();
    t += 5_000; // still inside TTL
    await checker.getStatus();
    expect(fetchCalls()).toBe(1);
    t += 6_000; // past TTL
    await checker.getStatus();
    expect(fetchCalls()).toBe(2);
  });

  it("deduplicates concurrent callers into one fetch (single-flight)", async () => {
    const { checker, fetchCalls } = makeChecker({ results: ["2.0.0"] });
    const [a, b, c] = await Promise.all([
      checker.getStatus(),
      checker.getStatus(),
      checker.getStatus(),
    ]);
    expect(fetchCalls()).toBe(1);
    expect(a.latest_version).toBe("2.0.0");
    expect(b.latest_version).toBe("2.0.0");
    expect(c.latest_version).toBe("2.0.0");
  });

  it("negative-caches failures with the shorter TTL, then retries", async () => {
    let t = 1_000_000;
    const { checker, fetchCalls } = makeChecker({
      results: [new Error("github down"), "2.0.0"],
      now: () => t,
      successTtlMs: 100_000,
      failureTtlMs: 10_000,
    });
    const failed = await checker.getStatus();
    expect(failed.update_available).toBe(false);
    expect(failed.latest_version).toBeNull();
    expect(failed.checked_at).toBeNull();

    t += 5_000; // inside failure TTL — no refetch
    await checker.getStatus();
    expect(fetchCalls()).toBe(1);

    t += 6_000; // past failure TTL — retry succeeds
    const ok = await checker.getStatus();
    expect(fetchCalls()).toBe(2);
    expect(ok.update_available).toBe(true);
    expect(ok.latest_version).toBe("2.0.0");
  });

  it("keeps the last known result visible through a transient failure", async () => {
    let t = 1_000_000;
    const { checker } = makeChecker({
      results: ["2.0.0", new Error("github down")],
      now: () => t,
      successTtlMs: 10_000,
      failureTtlMs: 10_000,
    });
    const first = await checker.getStatus();
    expect(first.update_available).toBe(true);

    t += 11_000; // success expired → refresh fails
    const second = await checker.getStatus();
    expect(second.update_available).toBe(true);
    expect(second.latest_version).toBe("2.0.0");
    expect(second.checked_at).toBe(first.checked_at);
  });
});
