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
`@appstrate/afps-shared` by caret range (`^0.5.0` today — read
`packages/core/package.json`, not this line). A bumped range must
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

### Work parked for "the next core major" needs an owner and a trigger

A breaking change that is right to keep out of an unrelated PR gets parked until
the next major. The gate above does not track those, and nothing else does
either — so a park written as "next core major" is a park with no owner and no
trigger, and it misses its window.

Measured: `resolveSubscriptionChatModel` / `SubscriptionChatResolution` were
parked on exactly those terms during the post-Pi-unification cleanup. The 7.0.0
major then arrived and passed **without** the rename, which cost a second major
(8.0.0) to carry work that had been ready the whole time. When you park a
breaking change, name the release that will carry it and the person who will
notice — in an issue, not in a plan document.

## 4. Refresh the published-export baseline

`packages/core/test/published-export-baseline.json` records the export set of
the version ON NPM. `packages/core/test/export-surface.test.ts` diffs HEAD
against it and fails when an export vanished without the CHANGELOG's
`[Unreleased]` section naming it — the only guard on that surface, because
`knip.config.ts` lists every core subpath as an entry (its readers are out of
tree) and therefore never reports a core export as unused.

Regenerate it from the TARBALL, after the publish lands:

```sh
cd "$(mktemp -d)" && npm pack @appstrate/core@X.Y.Z --silent && tar -xzf ./*.tgz
bun -e 'const {exportedNames}=await import(process.env.REPO+"/packages/core/test/helpers/export-surface.ts");
  const n=await exportedNames("package/src");
  await Bun.write(process.env.REPO+"/packages/core/test/published-export-baseline.json",
    JSON.stringify({version:"X.Y.Z",exports:Object.keys(n).sort()},null,2)+"\n")'
```

Not from the workspace and not from a git tag: `cloud/node_modules/@appstrate/core`
is a symlink into this monorepo, so a green local typecheck says nothing about
what a consumer can resolve. The tarball is the only source that does.

Skipping this step does not break the build — it makes the next release's diff
span two versions, so the `[Unreleased]` section is asked to document changes
that already shipped.

## What the gate actually checks

`scripts/check-consumer-versions.ts` compares each consumer's declared
`@appstrate/core` range (from `dependencies`, `devDependencies` **and**
`peerDependencies`) against the version being published. The verdicts below
block the publish under the default `fail` policy; `warn` reports them without
blocking, `off` skips the check entirely.

| Consumer state                                  | Verdict                                 |
| ----------------------------------------------- | --------------------------------------- |
| Major mismatch                                  | fail                                    |
| Exactly one major behind, **at an `X.0.0`**     | warn (see step 2)                       |
| ≥ 2 minors behind                               | fail                                    |
| 1 minor behind                                  | warn                                    |
| In sync, or patch-behind                        | ok                                      |
| Ahead within the same major                     | ok — logged as `in sync`                |
| Fetch error (including 404, rate limit, outage) | fail under `fail`; warning under `warn` |
| No `@appstrate/core` in the merged deps         | informational log; not counted          |
| Unparsable range                                | fail under `fail`; warning under `warn` |

A clean run prints `Summary: 0 failure(s), 0 warning(s)`. It no longer hides a
failed fetch or an unparsable range: both are counted. It can still include an
informational "does not depend on `@appstrate/core`" line, so read the
per-consumer output too.

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

Both consumers are private, so the repository secret
**`CONSUMER_LOCKSTEP_TOKEN`** must hold a PAT or GitHub App token with
`contents:read` on both. There is no separate preflight and no fallback token:
the script checks capability with the real contents requests. An absent token or
a token that cannot read a consumer makes that fetch fail. The strict `fail`
policy blocks the publish, explicit `warn` reports the failed reads and
continues, and `off` skips the check before any request.

## Bypassing — deliberate and auditable

Set the repository **variable** `CONSUMER_DRIFT_POLICY` to `warn` or `off`, and
**delete it again once the publish is through**. `warn` reports without
blocking; `off` skips the gate entirely.

The script is the single policy resolver. Only the exact lowercase values
`warn` and `off` bypass blocking. An absent or unrecognized value — including
wrong case such as `FAIL`, `WARN` or `OFF` — resolves to `fail`; unrecognized
values also emit a warning.
