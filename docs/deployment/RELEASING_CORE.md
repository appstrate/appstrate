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

Membership is not a release-time decision. The rule for adding and removing
entries lives in the `CONSUMERS` doc-comment in that script — it addresses
whoever retires, archives or absorbs a product, not whoever cuts a release.

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
`peerDependencies`) against the version being published. The verdicts below
block the publish under the default `fail` policy; `warn` reports them without
blocking, `off` skips the check entirely.

| Consumer state                              | Verdict                                 |
| ------------------------------------------- | --------------------------------------- |
| Major mismatch                              | fail                                    |
| Exactly one major behind, **at an `X.0.0`** | warn (see step 2)                       |
| ≥ 2 minors behind                           | fail                                    |
| 1 minor behind                              | warn                                    |
| In sync, or patch-behind                    | ok                                      |
| Ahead within the same major                 | ok — logged as `in sync`                |
| Fetch error (403, rate limit, outage)       | fail — "could not verify" is a failure  |
| 404 on the path                             | logged, counted as nothing              |
| No `@appstrate/core` in the merged deps     | logged, counted as nothing              |
| Unparsable range                            | logged, counted as nothing — not a warn |

A clean run prints `Summary: 0 failure(s), 0 warning(s)` — not proof every
consumer was assessed: the last three rows produce it too, and an unparsable
range leaves a listed consumer unassessed. Read the per-consumer lines above it.

**It is a drift alarm, not a compatibility guard.** Publishing a new major
breaks no consumer at install time — a `^2` range keeps resolving 2.x. What the
gate buys is that nobody forgets the bump and discovers it months later.

The workflow runs it **before** `npm publish`, and a `fail` verdict is `exit 1`
— the publish does not happen. The tag is pushed before the job runs, so it is
already consumed, but the version is not lost: the gate re-reads each consumer's
**default branch** at run time, and the workflow re-runs against that same tag
ref (`gh run rerun --failed`, or `workflow_dispatch` selecting the tag). Push
the consumer bump the gate named, re-run, and the same version publishes. Only a
_cancelled_ job forces a bump. Never re-point the tag at a new commit.

## The gate only bites with a token that can read private repos

Both consumers are private, and the gate step passes
`secrets.CONSUMER_LOCKSTEP_TOKEN` as `GITHUB_TOKEN` with **no fallback**. Unset,
the script sends no `Authorization` header at all — the request goes out
anonymous (60 req/h), the contents API answers 404 for a private repo, and the
script logs `not present, skipping`, indistinguishable from a repo that
genuinely has no `package.json` there. The gate then prints
`0 failure(s), 0 warning(s)` having verified **nothing**. So the repository
secret **`CONSUMER_LOCKSTEP_TOKEN`** must exist, holding a PAT or GitHub App
token with `contents:read` on both consumer repos; it was added on 2026-07-28,
so treat any green run from before that date as unverified.

**The "Assert the lockstep gate can actually run" step does not police that.**
It tests that the secret is a non-empty string — it never contacts the API and
never checks scope, so a token that is present but can no longer read a consumer
passes the assert, 404s on it, and leaves the gate silently inert exactly as an
absent secret would. Full rationale for the step: the comment above it in
`publish-core.yml`.

## Bypassing — deliberate and auditable

Set the repository **variable** `CONSUMER_DRIFT_POLICY` to `warn` or `off`, and
**delete it again once the publish is through**. It relaxes both the assert step
and the gate.

Unset, the policy is `fail` — and so is any unrecognized value, **in the
script**: `resolvePolicy` coerces a typo, or wrong case like `FAIL`, back to
`fail` with a warning. The workflow's assert step does not share that logic — it
compares the raw string against `"fail"` literally and case-sensitively, so
`CONSUMER_DRIFT_POLICY=FAIL` takes its warn branch and exits 0 while the script
still treats the same value as `fail`.
