// SPDX-License-Identifier: Apache-2.0

// Boot refusal while `oauth_clients.self_service` still contradicts the
// `metadata` JSON key drizzle `0057` left behind — i.e. while
// `scripts/migration/0011-oauth-clients-self-service-fold.sql` has not run.
//
// The count is injected, so these run without a database; the live probe is
// exercised against seeded rows in
// `../integration/db/oauth-client-self-service-fold-migration.test.ts`.
// See docs/NO_TRANSITIONAL_CODE.md §5 — this check must never repair.

import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { assertSelfServiceFoldApplied } from "../../src/lib/boot.ts";

describe("assertSelfServiceFoldApplied", () => {
  it("returns without throwing once no row is left to fold", async () => {
    expect(await assertSelfServiceFoldApplied(async () => 0)).toBeUndefined();
  });

  it("refuses to boot while a single unfolded self-service client remains", async () => {
    await expect(assertSelfServiceFoldApplied(async () => 1)).rejects.toThrow(/Refusing to boot/);
  });

  it("names the operator script rather than repairing", async () => {
    await expect(assertSelfServiceFoldApplied(async () => 3)).rejects.toThrow(
      /scripts\/migration\/0011-oauth-clients-self-service-fold\.sql/,
    );
  });

  // The operator has to know how many clients are exposed before deciding how
  // urgently to act, so the count is part of the message and not just the trigger.
  it("reports how many rows are still unfolded", async () => {
    await expect(assertSelfServiceFoldApplied(async () => 7)).rejects.toThrow(/7 oauth client/);
  });

  it("propagates a failing probe instead of assuming the fold ran", async () => {
    const boom = new Error("connection terminated");
    await expect(assertSelfServiceFoldApplied(() => Promise.reject(boom))).rejects.toThrow(boom);
  });

  // The message is the operator's only remediation path, so the file it names
  // has to exist and has to carry the fold — and its `WHERE` has to be the one
  // the boot probe tests, or a refusal could survive a successful run.
  it("the named script folds exactly the rows this refuses on", async () => {
    const sql = await Bun.file(
      resolve(
        import.meta.dir,
        "../../../../scripts/migration/0011-oauth-clients-self-service-fold.sql",
      ),
    ).text();
    expect(sql).toContain("UPDATE oauth_clients\nSET self_service = true");
    for (const clause of [
      "self_service = false",
      "pg_input_is_valid(metadata, 'jsonb')",
      "metadata::jsonb ->> 'selfService' = 'true'",
    ]) {
      expect(sql).toContain(clause);
    }
  });
});
