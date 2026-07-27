// SPDX-License-Identifier: Apache-2.0

/**
 * The platform and the AFPS runtime both mint RFC 9457 `type` URIs under
 * `https://docs.appstrate.dev/errors`. Their code catalogues are independent
 * and they DO overlap on names that mean different things:
 *
 *   - `integrity_mismatch` (API, 409) — this version already exists with
 *     different content (`routes/packages.ts`).
 *   - `INTEGRITY_MISMATCH` (AFPS) — stored bytes no longer hash to their
 *     recorded SRI (`afps-runtime/src/bundle/errors.ts`). The platform maps
 *     it to `bundle_integrity_mismatch`, precisely because it is NOT the
 *     same failure (`run-launcher/bundle-error-mapping.ts`).
 *
 * A flat namespace would send both to one document. The runtime therefore
 * emits `/errors/afps/{slug}`. This file is the guard on that separation:
 * strip the `afps/` segment and the disjointness assertion below fails.
 *
 * The docs site lowercases before matching, and neither implementation case
 * folds (`RUN_TIMEOUT` → `RUN-TIMEOUT`), so every comparison here is done on
 * the lowercased URI — otherwise `INTEGRITY-MISMATCH` and `integrity-mismatch`
 * would read as distinct and the test would miss exactly this class of bug.
 */

import { describe, it, expect } from "bun:test";
import { Glob } from "bun";
import { AFPS_ERROR_CODES, afpsErrorTypeUri } from "@appstrate/afps-runtime/errors";
import { ApiError } from "@appstrate/core/api-errors";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

/**
 * Source roots that construct `ApiError`s. Scanning source rather than
 * hard-coding a list keeps the catalogue current as routes are added.
 */
const API_SOURCE_ROOTS = ["apps/api/src", "packages/core/src", "packages/db/src"];

/**
 * Construction sites for a platform error code.
 *
 * These run over whole-file text, NOT line by line. That distinction is the
 * entire reason this file exists: `conflict(` / `gone(` calls are wrapped by
 * prettier so the code literal frequently sits on the FOLLOWING line, and a
 * line-anchored sweep silently misses them — which is how the
 * `integrity_mismatch` collision went unnoticed. The sentinel assertions
 * below pin several wrapped call sites so a regression to line-scanning
 * fails loudly.
 */
const CODE_PATTERNS: readonly RegExp[] = [
  /\bcode:\s*"([a-zA-Z0-9_]+)"/g,
  /\bconflict\(\s*"([a-zA-Z0-9_]+)"/g,
  /\bgone\(\s*"([a-zA-Z0-9_]+)"/g,
];

async function collectApiErrorCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  for (const root of API_SOURCE_ROOTS) {
    const glob = new Glob("**/*.ts");
    for await (const rel of glob.scan({ cwd: `${REPO_ROOT}${root}` })) {
      const text = await Bun.file(`${REPO_ROOT}${root}/${rel}`).text();
      for (const pattern of CODE_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) codes.add(match[1]!);
      }
    }
  }
  return codes;
}

/** The URI the platform mints for a code. */
function apiTypeUri(code: string): string {
  return new ApiError({ status: 422, code, title: "t", detail: "d" }).toProblemDetail("req_test")
    .type;
}

/** Normalisation the docs site applies before matching a page. */
function normalise(uri: string): string {
  return uri.toLowerCase();
}

describe("error code enumeration", () => {
  it("scans whole files, so wrapped conflict()/gone() call sites are not missed", async () => {
    const codes = await collectApiErrorCodes();

    // Each of these sits on the line AFTER `conflict(` / `gone(` in source.
    // A line-anchored scan finds none of them.
    for (const wrapped of [
      "integrity_mismatch",
      "version_exists",
      "draft_overwrite",
      "run_sink_expired",
      "wrong_package_type",
    ]) {
      expect(codes).toContain(wrapped);
    }
  });

  it("finds the expected order of magnitude of platform codes", async () => {
    const codes = await collectApiErrorCodes();
    // Floor, not an exact count — new routes add codes. A scanner that
    // breaks (bad glob, bad regex) collapses well below this.
    expect(codes.size).toBeGreaterThanOrEqual(150);
  });

  it("enumerates the runtime catalogue from its own exhaustive table", () => {
    expect(AFPS_ERROR_CODES.length).toBeGreaterThanOrEqual(38);
    expect(AFPS_ERROR_CODES).toContain("INTEGRITY_MISMATCH");
    expect(AFPS_ERROR_CODES).toContain("DEPENDENCY_UNRESOLVED");
  });
});

describe("platform and runtime error URIs are disjoint", () => {
  it("no AFPS type URI collides with a platform type URI", async () => {
    const apiUris = new Map<string, string>();
    for (const code of await collectApiErrorCodes()) {
      apiUris.set(normalise(apiTypeUri(code)), code);
    }

    const collisions: string[] = [];
    for (const code of AFPS_ERROR_CODES) {
      const uri = normalise(afpsErrorTypeUri(code));
      const clash = apiUris.get(uri);
      if (clash !== undefined) collisions.push(`${code} <-> ${clash} (${uri})`);
    }

    expect(collisions).toEqual([]);
  });

  it("would collide without the afps/ namespace segment — the separation is load-bearing", async () => {
    // Positive control. If this stops finding collisions, either the
    // catalogues changed or the scanner broke; either way the assertion
    // above has quietly stopped proving anything.
    const apiUris = new Set(
      [...(await collectApiErrorCodes())].map((code) => normalise(apiTypeUri(code))),
    );

    const wouldCollide = AFPS_ERROR_CODES.filter((code) =>
      // The URI the runtime WOULD emit if the `afps/` segment were removed.
      apiUris.has(normalise(`https://docs.appstrate.dev/errors/${code.replace(/_/g, "-")}`)),
    );

    expect(wouldCollide.sort()).toEqual(["DEPENDENCY_UNRESOLVED", "INTEGRITY_MISMATCH"]);
  });

  it("every runtime URI carries the namespace segment", () => {
    for (const code of AFPS_ERROR_CODES) {
      expect(afpsErrorTypeUri(code).startsWith("https://docs.appstrate.dev/errors/afps/")).toBe(
        true,
      );
    }
  });
});
