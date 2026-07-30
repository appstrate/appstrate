// SPDX-License-Identifier: Apache-2.0

/**
 * Severity table for the `@appstrate/core` lockstep gate. This decision gates
 * an irreversible `npm publish`, so every branch is pinned here — including the
 * major-release carve-out from issue #1028 (a consumer cannot declare `^X.0.0`
 * before X.0.0 exists on npm, so at an X.0.0 release "one major behind" is the
 * only reachable state) and the non-major case that keeps the gate's teeth.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { assessDrift, fetchPackageJson } from "../check-consumer-versions.ts";

type V = [number, number, number];

const verdict = (local: V, consumer: V) => assessDrift(local, consumer).verdict;

describe("assessDrift — major mismatch", () => {
  it("warns when a MAJOR release finds a consumer exactly one major behind (#1028)", () => {
    expect(verdict([6, 0, 0], [5, 0, 0])).toBe("warn");
    expect(verdict([6, 0, 0], [5, 4, 2])).toBe("warn");
  });

  it("names the bump the consumer owes so the warning cannot read as an exemption", () => {
    const { detail } = assessDrift([6, 0, 0], [5, 0, 0]);
    expect(detail).toContain("^6.0.0");
    expect(detail).toContain("next core release");
  });

  it("fails a MAJOR release when the consumer is two or more majors behind", () => {
    expect(verdict([6, 0, 0], [4, 0, 0])).toBe("fail");
    expect(verdict([6, 0, 0], [2, 13, 0])).toBe("fail");
  });

  it("fails a NON-major release even when the consumer is one major behind", () => {
    // The teeth: a consumer that never bumps after the major is caught by the
    // very next core publish.
    expect(verdict([6, 0, 1], [5, 0, 0])).toBe("fail");
    expect(verdict([6, 1, 0], [5, 0, 0])).toBe("fail");
    expect(verdict([6, 1, 3], [5, 9, 9])).toBe("fail");
  });

  it("fails when the consumer is AHEAD by a major, including on a major release", () => {
    expect(verdict([6, 0, 0], [7, 0, 0])).toBe("fail");
    expect(verdict([6, 1, 0], [7, 0, 0])).toBe("fail");
  });
});

describe("assessDrift — same major", () => {
  it("warns at 1 minor behind", () => {
    expect(verdict([6, 3, 0], [6, 2, 0])).toBe("warn");
    expect(verdict([6, 3, 1], [6, 2, 9])).toBe("warn");
  });

  it("fails at 2 or more minors behind", () => {
    expect(verdict([6, 3, 0], [6, 1, 0])).toBe("fail");
    expect(verdict([6, 12, 0], [6, 0, 0])).toBe("fail");
  });

  it("is OK when only the patch is behind", () => {
    expect(assessDrift([6, 2, 4], [6, 2, 1])).toEqual({
      verdict: "ok",
      detail: "patch-behind, OK",
    });
  });

  it("is OK when in sync", () => {
    expect(assessDrift([6, 2, 4], [6, 2, 4])).toEqual({ verdict: "ok", detail: "in sync" });
  });

  it("is OK when the consumer is ahead within the same major (pinned current behaviour)", () => {
    // Not a state the release flow produces; pinned so a refactor cannot
    // silently turn it into a publish-blocking failure.
    expect(assessDrift([6, 2, 0], [6, 5, 0])).toEqual({ verdict: "ok", detail: "in sync" });
    expect(assessDrift([6, 2, 0], [6, 2, 7])).toEqual({ verdict: "ok", detail: "in sync" });
  });
});

describe("fetchPackageJson", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(status: number, statusText: string, body?: unknown): void {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          statusText,
        }),
      { preconnect: () => undefined },
    );
  }

  it("THROWS on 404 instead of reporting an absent file", async () => {
    // The regression this guards: 404 used to return null, which main() logged
    // as "not present, skipping" and counted as neither warning nor failure. A
    // CONSUMER_LOCKSTEP_TOKEN that could read neither private consumer then
    // produced `Summary: 0 failure(s)` having verified nothing, and
    // core@6.1.0 published unchecked. Every listed consumer is a live npm
    // package and therefore HAS a package.json, so 404 is always a read
    // failure — it must reach main()'s fail-closed catch.
    stubFetch(404, "Not Found");
    await expect(fetchPackageJson("appstrate/cloud", "package.json")).rejects.toThrow(/404/);
  });

  it("names the token and the likely causes in the 404 message", async () => {
    // The message is the operator's only clue. Bare "404 Not Found" reads as
    // "the file was deleted" and sends them to look in the wrong place.
    stubFetch(404, "Not Found");
    const err = await fetchPackageJson("appstrate/cloud", "package.json").catch(
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("READ failure");
    expect(err.message).toContain("contents:read");
    expect(err.message).toContain("appstrate/cloud");
  });

  it("still throws on other non-2xx statuses", async () => {
    stubFetch(403, "Forbidden");
    await expect(fetchPackageJson("appstrate/cloud", "package.json")).rejects.toThrow(/403/);
  });

  it("returns the parsed package.json on success", async () => {
    stubFetch(200, "OK", {
      name: "@appstrate/cloud",
      dependencies: { "@appstrate/core": "^6.1.0" },
    });
    const pkg = await fetchPackageJson("appstrate/cloud", "package.json");
    expect(pkg.name).toBe("@appstrate/cloud");
  });
});
