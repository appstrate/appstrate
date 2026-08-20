<!-- SPDX-License-Identifier: Apache-2.0 -->

# Post-unification cleanup — plan

Follow-up to #1173 (`refactor(chat)!: run every chat turn on the Pi engine`,
merged as `14f8673db`), which retired the AI SDK inference loop so one
in-process Pi engine serves every chat turn.

The audit that accompanied that PR produced five follow-ups. They are **not**
homogeneous: one is an operations task with no code, one must wait for a core
major, and one is deliberately kept out so its effect stays measurable. This
document records which is which, and why — so the ones left out are not
re-discovered as oversights.

## Scope decision

| #   | Item                                                 | This PR    | Why                                                                                                                                            |
| --- | ---------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `CHAT_PI_MAX_CONCURRENCY` from measured capacity     | **Partly** | The measurement is an ops task on a cloud instance. What ships here is the instrumentation that makes it measurable, plus a boot-time warning. |
| 2   | `runPiChat` has no test (`engine.ts` at 4.9%)        | **Yes**    | The biggest genuine gap. Highest value item here.                                                                                              |
| 3   | `public-origin` coverage flag reports phantom misses | **Yes**    | Asked for explicitly. Caveat below.                                                                                                            |
| 4   | `isFinalChatStep` dead; `SubscriptionChat*` misnamed | **No**     | Both are published `@appstrate/core` surface. Removing/renaming needs a core major + consumer lockstep — a release process, not a cleanup.     |
| 5   | Pre-existing small debt                              | **Yes**    | Cheap, and adjacent enough that leaving it costs another pass.                                                                                 |

### On item 3

I recommended shipping the Codecov change as its own PR so its effect on patch
coverage is observable in isolation. Bundling it here means this PR's own patch
number moves for two reasons at once. Keeping it anyway, as asked — noting that
if the number looks surprising, item 3 is the confound.

### On item 4 — do not "fix" these here

`isFinalChatStep` is provably dead (`packages/core/src/chat-turn-metadata.ts`;
its only caller was the deleted AI SDK step loop), and
`resolveSubscriptionChatModel` / `SubscriptionChatResolution` now describe both
credential modes, not just subscriptions. Both are exported from published
`@appstrate/core/*` subpaths, and the rename additionally moves a name pinned by
`scripts/verify-module-contract.ts`. Neither out-of-tree consumer (`cloud`,
`connect-helper`) imports those subpaths, so the blast radius is small — but the
process is a core major release, and dragging one into a cleanup PR is how the
release deadlock in #1032 happened. Park them for the next core major.

---

## 1. Make chat capacity measurable

**Problem.** Every chat turn now reserves an in-process slot for its whole
duration, so `CHAT_PI_MAX_CONCURRENCY` (default 6) is the ceiling on concurrent
chats per API process — the 7th simultaneous chat gets a 429. The default is a
conservative product value, not a sizing decision, and the only figures that
exist are local (Apple M2 + PGlite): 69% of the retired AI SDK path's throughput
at 60 concurrent chats, p95 first-token within 1.1%.

**What cannot ship here.** The measurement itself. It needs an instrumented
cloud instance, real token/tool distributions, and the replica count — none of
which exist in this repo.

**What ships here.**

- A saturation signal. Today a refused turn logs and 429s, but nothing records
  how close to the ceiling a healthy process runs, so an operator cannot tell
  "never saturated" from "saturated constantly". Expose the high-water mark and
  a rejection counter.
- A boot-time warning when the cap is left at its default, naming the risk.

**Verification.** Unit tests on the counters. The warning is asserted at the
concurrency module's seam, not by booting the platform.

**Hand-off.** After deploy: read the high-water mark under real traffic, raise
the cap to the measured ceiling, redeploy. Until then the merged code should not
serve production chat traffic.

## 2. Drive a real Pi session in a test

**Problem.** `packages/module-chat/src/pi-chat/engine.ts` sits at 4.9% line
coverage. The body of the engine that now serves 100% of chat is executed by no
suite — unit or integration. The handler suite injects a scripted engine
precisely so a turn never opens a real Pi session against a real provider, which
was correct for testing the handler and left the engine untested.

**Approach.** The proxy binding already points the engine at a base URL. A test
can point it at a local stub speaking the `openai-completions` wire shape
(`Bun.serve`, SSE frames), then assert what only a real session can show:

- the UI-message-stream chunk sequence the mapper emits end to end;
- the `before_provider_headers` extension replacing `Authorization` on every
  provider request, with the inert `proxy` key never reaching the wire;
- terminal closure — `finish` metadata, and the concurrency slot released when
  the response stream drains.

**Non-goals.** Not asserting pi-ai's own request shape (that is the SDK's
contract, covered upstream), and not a second copy of the mapper's unit tests.

**Verification.** The test must fail if the auth extension is removed — a
coverage test that cannot fail is theatre.

## 3. Stop the `public-origin` flag reporting phantom misses

**Problem.** The `Run public-origin regression` job boots the whole platform to
exercise one OIDC route. Bun instruments every file that boot loads, so the
upload carries 0-hit lines for code the job never exercises. Codecov unions
sessions per line, and lines the `unit` session does not even emit stay missing
forever.

Measured on #1173:

| file               | `unit` session      | `public-origin` session | Codecov union         |
| ------------------ | ------------------- | ----------------------- | --------------------- |
| `chat-stream.ts`   | 252 lines / 239 hit | **408** / 31            | 411 lines, 172 missed |
| `model-binding.ts` | 92 / 92 (100%)      | **112** / 10            | 114 lines, 22 missed  |

`model-binding.ts` is fully covered and reported at 80.7%. This inflates patch
coverage against every PR touching a file the boot path loads, not just chat.

**Approach.** Scope the flag to the paths it is meant to measure, via
`flags.public-origin.paths` in `.codecov.yml`. The flag keeps its own signal;
it stops speaking for subsystems it merely imported.

**Verification.** Config only — no local test proves it. The check is the patch
number on this PR, and the note above about item 3 being a confound.

## 4. Parked — see the scope decision above.

## 5. Small pre-existing debt

Each verified during the audit; none caused by #1173.

- **`props.artifact` is always `undefined`** (`ui/tool-fallback.tsx`,
  `ui/tool-uis.tsx`, 9 sites). The assistant-ui ↔ AI SDK converter never sets
  it, so `definedEntries` drops it from the metadata modal every time. Remove
  the prop rather than leave a field that reads as available.
- **`PI_ADAPTER_TYPES` is one member behind `ModelApiShape`** (8 vs 9;
  `openai-codex-responses` absent). The omission is **correct** — codex is
  oauth-subscription-only and an operator cannot point a custom endpoint at it.
  The defect is that nothing says so and nothing enforces the rest of the list.
  Add a compile-time subset guard plus the carve-out in prose. Do **not** add
  codex to the picker.
- ~~**`@earendil-works/pi-coding-agent` devDep in `apps/api`** with no
  importer.~~ **Investigated and NOT removed.** It has no import statement, but
  it is not dead: `packages/runner-pi` declares the package in
  `peerDependencies`, and `apps/api` is the consumer that imports
  `@appstrate/runner-pi` — so this line is what satisfies that peer. A
  typecheck cannot see it, because the actual load is a runtime `import()`
  inside `loadPiCodingAgentSdk`.

  The `Dockerfile` documents this exact failure class above its install step:
  packages that value-import at runtime a dependency declared as a
  `devDependency`, where "the build stays GREEN and the failure only appears at
  runtime" — the reason the image deliberately avoids `--production`. Removing
  the one declaration that satisfies a declared peer moves the manifests
  further from the state that comment says must be fixed first. Left as is.

- **"subscription gateway" comment cluster** (6 sites across
  `services/llm-proxy/**`, `lib/egress-host-guard.ts`) describing a surface
  retired before #1173. `routes/llm-proxy.ts` already states the opposite, so
  the tree contradicts itself.

## Out of scope

Rewriting the chat's test strategy, touching `patch.target` or making the
Codecov `patch` status informational, and any change to `main`'s deploy
configuration.
