// SPDX-License-Identifier: Apache-2.0

/**
 * Static lock-order guard for the run-admission / run-teardown family.
 *
 * `orgRunConcurrencyLockKey`'s docstring states the one order every
 * participant must follow:
 *
 *   run_concurrency:<org> → organizations row → packages row → files rows
 *                         → run_number:<org>:<space>:<package>
 *
 * The cycle this pins closed: `createRun` used to `SELECT … FROM files … FOR
 * UPDATE` and only THEN take the per-org advisory key, while
 * `deletePackageRuns` and `deleteOrganization` take the key first and reach
 * `files` under it. Those two orders meet on a real row — a run's output file
 * is a legal `appfile://` input to the next run — so `POST /runs` holding the
 * file and waiting on the key, against a runs-delete holding the key and
 * waiting on the file, is a Postgres `40P01` and a 500 on one side.
 *
 * Why static rather than a reproduced deadlock: a deadlock needs two
 * simultaneous connections stalled at the exact interleaving, and the
 * zero-install tier this suite runs on is PGlite — one in-process connection,
 * no concurrency to schedule. A timing-dependent test on the tiers that do have
 * a connection pool would be flaky in both directions. The ORDER is the whole
 * invariant, and it is decidable from the source, so that is what is asserted —
 * same channel and cost as `finalize-convergence.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..", "src");

/**
 * The body of a top-level function, comments removed.
 *
 * Comment lines are dropped because every one of these functions explains its
 * lock order in prose that names the very symbols being ordered — an
 * `indexOf` over the raw text would match the explanation, not the call.
 */
function functionBody(relPath: string, signature: string): string {
  const source = readFileSync(join(SRC_ROOT, relPath), "utf8");
  const start = source.indexOf(signature);
  expect(start, `${signature} not found in ${relPath}`).toBeGreaterThanOrEqual(0);
  const after = source.indexOf("\nexport ", start + signature.length);
  const body = source.slice(start, after === -1 ? undefined : after);
  return body
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

/** Assert `first` appears before `second` in `body`. */
function assertOrder(body: string, label: string, first: string, second: string): void {
  const a = body.indexOf(first);
  const b = body.indexOf(second);
  expect(a, `${label}: '${first}' not found`).toBeGreaterThanOrEqual(0);
  expect(b, `${label}: '${second}' not found`).toBeGreaterThanOrEqual(0);
  expect(
    a,
    `${label}: '${first}' must be acquired BEFORE '${second}' — see orgRunConcurrencyLockKey`,
  ).toBeLessThan(b);
}

describe("run-admission lock order", () => {
  it("createRun takes the per-org admission key before locking input files", () => {
    const body = functionBody(
      "services/state/runs.ts",
      "export async function createRun(scope: SpaceScope, params: CreateRunParams)",
    );
    // `enforceOrgConcurrencyCap` is where the advisory key is acquired;
    // `.from(files)` … `.for("update")` is the input-file row lock.
    assertOrder(body, "createRun", "enforceOrgConcurrencyCap(tx, scope)", ".from(files)");
    expect(body).toContain('.for("update")');
  });

  it("createRun takes the per-org admission key before the per-package run_number key", () => {
    const body = functionBody(
      "services/state/runs.ts",
      "export async function createRun(scope: SpaceScope, params: CreateRunParams)",
    );
    assertOrder(
      body,
      "createRun",
      "enforceOrgConcurrencyCap(tx, scope)",
      "acquireRunNumberLock(tx, scope, packageId)",
    );
  });

  it("deletePackageRuns takes the per-org admission key before reaching files", () => {
    const body = functionBody(
      "services/state/runs.ts",
      "export async function deletePackageRuns(scope: SpaceScope, packageId: string)",
    );
    assertOrder(
      body,
      "deletePackageRuns",
      "orgRunConcurrencyLockKey(scope.orgId)",
      "detachOrDeleteContainedFiles(",
    );
  });

  it("deleteOrganization takes the per-org admission key before reaching files", () => {
    const body = functionBody(
      "services/organizations.ts",
      "export async function deleteOrganization(orgId: string)",
    );
    assertOrder(body, "deleteOrganization", "orgRunConcurrencyLockKey(orgId)", ".from(files)");
  });
});

/**
 * Same channel as the order guard above, for the same reason: the invariant is
 * decidable from the source, and the failure mode it guards is unreachable
 * through the public surface. `lib/scope.ts` declares `SpaceScope.orgId` and
 * `.spaceId` required and non-nullable, and says in prose that these types
 * "replace the old `{ orgId: "" }` sentinel" — so no caller can hand these
 * lock keys a nullish id, and no behavioural test can make the `?? ""` fire.
 *
 * It is still not inert. `??` on a non-nullable operand is dead scaffolding
 * that `docs/NO_TRANSITIONAL_CODE.md` forbids, and it is the loudest possible
 * kind: the day either field turns optional, every org silently collapses onto
 * `run_concurrency:` — ONE advisory lock serialising run admission platform-wide
 * — and nothing fails, it just queues.
 */
describe("run-admission lock keys", () => {
  it("derives both advisory keys from the scope's real ids, with no empty-string sentinel", () => {
    const source = readFileSync(join(SRC_ROOT, "services/state/runs.ts"), "utf8");

    // Positive control: the two keys still exist and are still scope-derived,
    // so the `not.toContain`s below cannot pass by the expressions having been
    // renamed or deleted out from under them.
    expect(source).toContain("`run_number:${scope.orgId}:${scope.spaceId}:${packageId}`");
    expect(source).toContain("orgRunConcurrencyLockKey(scope.orgId)");

    expect(source).not.toContain('scope.orgId ?? ""');
    expect(source).not.toContain('scope.spaceId ?? ""');
  });
});
