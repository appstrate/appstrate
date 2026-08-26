// SPDX-License-Identifier: Apache-2.0

// Boot refusal on `__drizzle_migrations` watermark drift.
//
// The predicate is injected (`columnExists`), so these run without a database:
// the live probe reads information_schema and is exercised by every real boot.
// See docs/NO_TRANSITIONAL_CODE.md §5 — this check must never repair.

import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { assertOAuthResourceColumnsPresent } from "../../src/lib/boot.ts";

describe("assertOAuthResourceColumnsPresent", () => {
  it("returns without throwing when the 0006 columns are present", async () => {
    expect(await assertOAuthResourceColumnsPresent(async () => true)).toBeUndefined();
  });

  it("refuses to boot when the 0006 columns are absent", async () => {
    await expect(assertOAuthResourceColumnsPresent(async () => false)).rejects.toThrow(
      /Refusing to boot/,
    );
  });

  it("names the operator script rather than repairing", async () => {
    await expect(assertOAuthResourceColumnsPresent(async () => false)).rejects.toThrow(
      /scripts\/migration\/0003-oauth-resources-watermark-drift\.sql/,
    );
  });

  it("propagates a failing probe instead of assuming the schema is healthy", async () => {
    const boom = new Error("connection terminated");
    await expect(assertOAuthResourceColumnsPresent(() => Promise.reject(boom))).rejects.toThrow(
      boom,
    );
  });

  // The message is the operator's only remediation path, so the file it names
  // has to exist and has to carry the DDL boot no longer runs.
  it("the named script ships migration 0006's DDL", async () => {
    const sql = await Bun.file(
      resolve(
        import.meta.dir,
        "../../../../scripts/migration/0003-oauth-resources-watermark-drift.sql",
      ),
    ).text();
    for (const table of ["oauth_access_tokens", "oauth_consents", "oauth_refresh_tokens"]) {
      expect(sql).toContain(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "resources" text[];`);
    }
    expect(sql).toContain(
      `ALTER TABLE "oauth_clients" ALTER COLUMN "level" SET DEFAULT 'instance';`,
    );
  });
});
