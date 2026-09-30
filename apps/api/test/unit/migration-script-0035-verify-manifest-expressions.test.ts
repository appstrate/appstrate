// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0035-verify-manifest-expressions.ts` on a private PGlite replayed to the
 * current schema: its query reads every integration draft and published version, and the report
 * lists both the expressions the platform no longer evaluates and the injected credentials a run
 * now refuses as `exfiltration`, and nothing for a clean manifest.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { replayJournal } from "../helpers/journal.ts";
import {
  STORED_MANIFESTS_QUERY,
  manifestIssues,
  type StoredManifest,
} from "../../../../scripts/migration/0035-verify-manifest-expressions.ts";

const CLEAN = "@acme0035/clean";
const BROKEN = "@acme0035/broken";

const apiKeyAuth = (extra: Record<string, unknown>) => ({
  type: "api_key",
  delivery: { http: { in: "header", name: "X-Api-Key", value: "{$credential.api_key}" } },
  ...extra,
});

const pg = new PGlite();

beforeAll(async () => {
  await replayJournal(pg);
  const clean = { auths: { k: apiKeyAuth({ authorized_uris: ["https://api.acme.test/**"] }) } };
  const draft = {
    auths: {
      k: apiKeyAuth({
        authorized_uris: ["https://api.acme.test/**"],
        delivery: { http: { in: "header", name: "X-Api-Key", value: "{$outputs.api_key}" } },
      }),
    },
  };
  const published = { auths: { k: apiKeyAuth({ allow_all_uris: true }) } };
  await pg.query(
    `INSERT INTO packages (id, type, draft_manifest) VALUES ($1, 'integration', $2), ($3, 'integration', $4), ('@acme0035/agent', 'agent', $5)`,
    [CLEAN, JSON.stringify(clean), BROKEN, JSON.stringify(draft), JSON.stringify(published)],
  );
  await pg.query(
    `INSERT INTO package_versions (package_id, version, integrity, artifact_size, manifest) VALUES ($1, '1.0.0', 'sha256-x', 1, $2)`,
    [BROKEN, JSON.stringify(published)],
  );
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0035 — stored manifests the release refuses", () => {
  it("lists unevaluable expressions and credentials runs will refuse, integrations only", async () => {
    const { rows } = await pg.query<StoredManifest>(STORED_MANIFESTS_QUERY);
    expect(rows.map((r) => `${r.id}@${r.version}`)).toEqual([
      `${BROKEN}@1.0.0`,
      `${BROKEN}@draft`,
      `${CLEAN}@draft`,
    ]);

    const report = manifestIssues(rows);
    expect(report.expressions).toBe(1);
    expect(report.exfiltration).toBe(1);
    expect(report.lines.map((l) => l.split(":")[0])).toEqual([
      `${BROKEN}@1.0.0 [exfiltration] auths.k.allow_all_uris`,
      `${BROKEN}@draft [expression] auths.k.delivery.http.value`,
    ]);
  });
});
