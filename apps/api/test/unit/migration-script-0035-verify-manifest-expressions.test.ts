// SPDX-License-Identifier: Apache-2.0

/**
 * `scripts/migration/0035-verify-manifest-expressions.ts` on a private PGlite replayed to the
 * current schema: its query reads every org integration draft and published version, and the
 * report lists the expressions the platform does not evaluate, the `{{field}}` placeholders a
 * delivery template leaves as literal text and the injected credentials a run refuses as
 * `exfiltration`, and nothing for a clean manifest. Every version is gated — a range resolves
 * older ones too — and a system package is not read at all.
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
const DOWNGRADED = "@acme0035/downgraded";
const BROKEN = "@acme0035/broken";
const UPGRADED = "@acme0035/upgraded";
const SYSTEM = "@acme0035/system";

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
  // A run drops `allow_all_uris` beside a bounded list and serves the list: nothing to refuse.
  const downgraded = {
    auths: {
      k: apiKeyAuth({ allow_all_uris: true, authorized_uris: ["https://api.acme.test/**"] }),
    },
  };
  await pg.query(
    `INSERT INTO packages (id, type, draft_manifest) VALUES ($1, 'integration', $2), ($3, 'integration', $4), ('@acme0035/agent', 'agent', $5), ($6, 'integration', $7)`,
    [
      CLEAN,
      JSON.stringify(clean),
      BROKEN,
      JSON.stringify(draft),
      JSON.stringify(published),
      DOWNGRADED,
      JSON.stringify(downgraded),
    ],
  );
  await pg.query(
    `INSERT INTO packages (id, type, source, draft_manifest) VALUES ($1, 'integration', 'local', $2), ($3, 'integration', 'system', $4)`,
    [UPGRADED, JSON.stringify(clean), SYSTEM, JSON.stringify(published)],
  );
  await pg.query(
    `INSERT INTO package_versions (package_id, version, integrity, artifact_size, manifest) VALUES ($1, '1.0.0', 'sha256-x', 1, $2), ($3, '1.0.0', 'sha256-x', 1, $2), ($3, '2.0.0', 'sha256-x', 1, $4), ($5, '1.0.0', 'sha256-x', 1, $2)`,
    [BROKEN, JSON.stringify(published), UPGRADED, JSON.stringify(clean), SYSTEM],
  );
  await pg.query(
    `INSERT INTO package_dist_tags (package_id, tag, version_id)
     SELECT package_id, 'latest', id FROM package_versions
      WHERE (package_id, version) IN (($1, '1.0.0'), ($2, '2.0.0'), ($3, '1.0.0'))`,
    [BROKEN, UPGRADED, SYSTEM],
  );
}, 300_000);

afterAll(async () => {
  await pg.close();
});

describe("0035 — stored manifests the release refuses", () => {
  it("lists unevaluable expressions and credentials runs will refuse, org integrations only", async () => {
    const { rows } = await pg.query<StoredManifest>(STORED_MANIFESTS_QUERY);
    expect(rows.map((r) => `${r.id}@${r.version}`)).toEqual([
      `${BROKEN}@1.0.0`,
      `${BROKEN}@draft`,
      `${CLEAN}@draft`,
      `${DOWNGRADED}@draft`,
      `${UPGRADED}@1.0.0`,
      `${UPGRADED}@2.0.0`,
      `${UPGRADED}@draft`,
    ]);

    const report = manifestIssues(rows);
    expect(report.expressions).toBe(1);
    expect(report.exfiltration).toBe(2);
    // `UPGRADED@1.0.0` is not `latest`, but an agent on `^1.0.0` still runs it: it fails too.
    expect(report.lines.map((l) => l.split(":")[0])).toEqual([
      `${BROKEN}@1.0.0 [exfiltration] auths.k.allow_all_uris`,
      `${BROKEN}@draft [expression] auths.k.delivery.http.value`,
      `${UPGRADED}@1.0.0 [exfiltration] auths.k.allow_all_uris`,
    ]);
  });

  it("lists a {{field}} placeholder in a delivery template", () => {
    const delivery = { env: { A: { value: "{{ key }}" }, B: { value: "{$credential.key}" } } };
    const auth = apiKeyAuth({ authorized_uris: ["https://api.acme.test/**"], delivery });
    const manifest = JSON.stringify({ auths: { k: auth } });
    expect(manifestIssues([{ id: CLEAN, version: "draft", manifest }])).toEqual({
      lines: [
        `${CLEAN}@draft [expression] auths.k.delivery.env.A.value: '{{ key }}' is delivered as literal text; write {$credential.<field>}`,
      ],
      expressions: 1,
      exfiltration: 0,
    });
  });
});
