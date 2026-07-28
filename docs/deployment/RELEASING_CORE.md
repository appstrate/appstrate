# Releasing @appstrate/core

`@appstrate/core` is a workspace package that is also published to npm, for the
repos that consume it from outside this monorepo. Publishing is triggered by
pushing a `core@X.Y.Z` git tag; `.github/workflows/publish-core.yml` runs the
checks and `npm publish`.

One of those checks is the **consumer lockstep gate**
(`scripts/check-consumer-versions.ts`), and it can block the publish. This
document is the procedure around it — most of the difficulty in a core release
is the gate, not the publish.

## Who is on the hook

`scripts/check-consumer-versions.ts` holds the authoritative list. It reads each
`package.json` off the repo's **default branch** through the GitHub contents
API. Today that is exactly two repos:

- `appstrate/cloud`
- `appstrate/connect-helper`

Two rules keep that list correct:

- **A package inside this monorepo is never listed.** It resolves `workspace:*`,
  cannot drift, and listing it would gate the publish on a version that does not
  exist yet. `packages/module-claude-code` is in-tree for exactly this reason.
- **A repo that stops consuming core from npm is removed in the same pass that
  stops it** — absorbed in-tree, retired or archived alike. Its default branch
  keeps whatever range it last published forever, so leaving it listed reports a
  permanent failure that no bump anywhere can clear. `registry` and `portal`
  left the list when those products were retired.

## 1. Before you tag

**Release the leaf first if its range moved.** Core depends on
`@appstrate/afps-shared` by caret range (`^0.3.1` today). A bumped range must
reach npm **before** the core release that references it, or installing
`@appstrate/core` cannot resolve it. The workflow's
`scripts/verify-package-resolves.ts` step packs the tarball and typechecks every
exported subpath in a clean npm project outside the monorepo, so a leaf that is
not on npm yet fails there — right before publish — rather than for the first
consumer to install.

**For a non-major release, bump the consumers first.** There is no carve-out and
no ordering question: every consumer must already be on `^X` before you tag, or
the gate fails hard.

## 2. Tag and publish — for a MAJOR, the tag comes FIRST

Tag `core@X.0.0` and push it. Do **not** bump the consumers first.

A consumer physically cannot declare `^X.0.0` before X.0.0 exists on npm — its
own CI runs `bun install --frozen-lockfile`, which cannot resolve an unpublished
version. Inverting the order is therefore a deadlock: each consumer's CI goes
red _and_ the gate blocks the very publish that would unblock it (issue #1028).

The gate accommodates this and only this: at an `X.0.0` release, a consumer
found **exactly one major behind** is a **warning**, not a failure.

## 3. Bump the consumers right after

Bump `cloud` and `connect-helper` to `^X.0.0` and push to each default branch.

This is not optional politeness. **The carve-out is scoped to `X.0.0` alone** —
the very next core release (`X.0.1`, `X.1.0`, anything non-major) fails hard on
a consumer still pinned to `^(X-1)`. That is what keeps the gate's teeth: an
unbumped consumer does not stay quiet, it blocks the next publish.

## What the gate actually checks

`scripts/check-consumer-versions.ts` compares each consumer's declared
`@appstrate/core` range (from `dependencies`, `devDependencies` **and**
`peerDependencies`) against the version being published:

| Consumer state                              | Verdict                                |
| ------------------------------------------- | -------------------------------------- |
| Major mismatch                              | fail                                   |
| Exactly one major behind, **at an `X.0.0`** | warn (see step 2)                      |
| ≥ 2 minors behind                           | fail                                   |
| 1 minor behind                              | warn                                   |
| In sync, or patch-behind                    | ok                                     |
| Fetch error (403, rate limit, outage)       | fail — "could not verify" is a failure |
| 404 on the path                             | skipped, counted as nothing            |

A clean run prints `Summary: 0 failure(s), 0 warning(s)`.

**It is a drift alarm, not a compatibility guard.** Publishing a new major
breaks no consumer at install time — a `^2` range keeps resolving 2.x. What the
gate buys is that nobody forgets the bump and discovers it months later.

The workflow runs it **before** `npm publish`, and a `fail` verdict is `exit 1`
— the publish does not happen. The tag, however, is pushed before the job runs,
so a blocked release leaves the tag consumed: fix the consumer the gate names
and release the next version rather than re-pointing the tag.

## The gate only bites with a token that can read private repos

Both consumers are private. `secrets.GITHUB_TOKEN` is scoped to this repo only,
so for a private consumer the contents API answers 404 — and the script treats
404 as `not present, skipping`, which is also the legitimate outcome for a repo
that genuinely has no `package.json` at that path. The script cannot tell the
two apart.

Net effect without a cross-repo token: the gate prints
`0 failure(s), 0 warning(s)` and passes **having verified nothing**. Treat any
green run from before 2026-07-28 as unverified — that is when the repository
secret **`CONSUMER_LOCKSTEP_TOKEN`** (PAT or GitHub App token with
`contents:read` on both consumer repos) was added.

The workflow's **"Assert the lockstep gate can actually run"** step is what
keeps it that way: the day the token expires, is revoked, or loses
`contents:read` on a consumer, that step fails loudly instead of letting the
gate go silently inert. The gate step itself deliberately has no
`|| secrets.GITHUB_TOKEN` fallback.

## Bypassing — deliberate and auditable

Set the repository **variable** `CONSUMER_DRIFT_POLICY` to `warn` or `off`, and
**delete it again once the publish is through**. It relaxes both the assert step
and the gate.

`fail` is the default when the variable is unset, and also the fallback for an
unrecognized value (a typo, or wrong case like `FAIL`) — a misconfigured
environment can never fail open. `off` skips the check entirely.
