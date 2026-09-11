# Model Aliases (LLM-gateway alias pattern)

Issue: appstrate#727

A **model alias** exposes a model under an Appstrate-branded vanity name (e.g.
`appstrate-medium`) while the real backing model (e.g. `deepseek-chat` on some
provider) stays hidden server-side. This is the same pattern LiteLLM, Portkey,
OpenRouter, and Kong call a _model alias_ / _virtual model_: a public name with
a private binding, rewritten on the inference data path.

## What an alias hides — and from whom

The product requirement is: **an organization must not learn which vendor backs
a platform (aliased) model.**

State it in the form that can actually be delivered — _the platform does not
disclose it_ — never as _the org cannot find out_. An agent can ask the model
who it is, and can fingerprint its tokenizer, its latency, its refusal style.
No amount of plumbing closes that, so a doc promising it would be promising
something false. What IS deliverable, and what the rest of this page describes,
is that no Appstrate surface hands the backing over.

There are two threat models against that requirement.

- **Threat A — the dashboard / API caller.** A user reading `/api/models`, a run
  detail, or calling `/api/llm-proxy/*` must not be HANDED the backing
  provider/endpoint/model id. **Partially closed, and it cannot be fully
  closed.** The read projection leaves only the alias identity plus the portable
  generation-support vector (see `projectAliasedModel`); every binding, pricing
  and catalog field is `null`. But a caller who can send arbitrary prompts
  through the gateway identifies the vendor anyway, and a structural oracle in
  the gateway's own routing identifies the protocol family before any prompt is
  sent. Written out in full under
  "[Threat A — what alias masking actually buys](#threat-a--what-alias-masking-actually-buys)".
- **Threat B — the agent runtime (adversarial code inside the container).** The
  agent needs _some_ protocol information to format requests. It gets a
  vendor-neutral dialect against the sidecar's own endpoint, with no rate card.
  This is not merely a sandbox-escape concern — the agent's own logs are an
  Appstrate surface, so an org member who prints the container env reads
  whatever is in it from the dashboard.

Threat B splits in two, and keeping the halves apart is what makes the
requirement writable at all: **what the platform discloses** to the container
(closed, inventoried and CI-gated) versus **what an observer can infer** from
the model's own behaviour (irreducible). Both are written out under
"[Threat B in two tiers](#threat-b-in-two-tiers)" at the end of this page; the
mechanism that closed the first half is the next three sections.

## The canonical dialect

pi-ai re-derives every vendor quirk **per request** from `model.provider` +
`model.baseUrl` (`getCompat` / `detectCompat`). A container handed the real
provider id therefore emits that vendor's own request shape and reads its own
response frames back — `reasoning_content` vs `reasoning`,
`prompt_cache_hit_tokens` vs `prompt_tokens_details.cached_tokens`, and fields
pi-ai never even reads (`system_fingerprint` appears nowhere in it) that still
cross the wire. Renaming identifying fields would be a **blacklist over a set
nobody can enumerate**: that set is a property of 14 live vendor APIs, not of
our source.

So the container speaks a different protocol. pi-ai ships one of its own —
**`pi-messages`**, a first-class `KnownApi` its source documents as usable by
any backend, not just the Radius gateway:

- **Request**: `POST <baseUrl>/messages`, `authorization: Bearer <apiKey>`, body
  `{ model, context, options }` — the model ID only, never the Model record.
  Zero vendor vocabulary and zero provider/baseUrl branching in the whole
  implementation.
- **Response**: an SSE stream of `PiMessagesEvent`, a CLOSED union (`start` /
  `text_*` / `thinking_*` / `toolcall_*` / `done` / `error`). Nothing
  vendor-shaped can ride in it. The container reconstructs provider/api/model
  from its own local Model, never from the wire.

For an aliased run the launcher therefore emits `MODEL_API=pi-messages` and no
`MODEL_PROVIDER`; the container's Pi model resolves its provider key from
`PROVIDER_BY_API["pi-messages"]`, which is Appstrate's own `appstrate` — a key
naming no vendor. Because pi has no builtin for it, the credential must go in
through `ModelRuntime.registerProvider` rather than `setRuntimeApiKey` (an
overlay on an EXISTING provider, which for an unknown id deletes the provider
and fails at request time with `Unknown provider`); `setPiRuntimeCredential`
handles both that key and `openai-codex` through the same door.

The **sidecar** is the `pi-messages` backend. An aliased run's inference call is
**terminated and re-originated, never proxied**: `POST /llm/messages` — inside
the same `/llm/*` handler the surface allowlist already guards, reusing its
placeholder→real-key swap and SSRF check — deserialises `{model, context,
options}`, rebuilds the REAL backing's pi-ai `Model` record from the private
swap descriptor, calls pi-ai's own `streamSimple`, and projects the resulting
`AssistantMessageEvent`s down to `PiMessagesEvent`s. Everything else in that
handler (header swap, body forward, response passthrough) serves non-aliased
runs only. **No quirk table is mirrored anywhere**: `detectCompat` and every
per-vendor serializer keep running inside pi-ai, one process to the left of the
container. The projection is a whitelist (each outbound event built field by
field, never a spread) because pi-ai's `partial` carries `api`, `provider` and
the real model id on every single event, and because a spread would ship the
next pi-ai version's new field to the container silently.

Three properties the backend must hold, each with a behavioral CI gate on the
always-on unit job:

- **`done` carries the real usage.** The platform prices `llm_usage.cost_usd`
  from those counts. The two OPTIONAL `Usage` members are dropped instead —
  `cacheWrite1h` is Anthropic-only and `reasoning` is reported only by providers
  that expose a breakdown, so each is a vendor tell; neither is priced.
  `usage.cost` is zeroed, and the rebuilt Model carries zero rates, so no rate
  card can travel.
- **Errors name nothing.** pi-ai's own error paths interpolate `model.provider`
  (`No API key provided for provider "<x>"`). The `error` event's message is
  REPLACED with `syntheticAliasClassifierMessage`, same whitelist posture as
  every other alias error surface. That helper takes NO `ModelSwap`: the alias
  is org-controlled text and this string is what a retry classifier matches on,
  so an alias named `gpt-500-fast` would otherwise make every failure on it
  retryable. The response stays `200 + SSE` even on failure:
  pi-ai's `pi-messages` reader treats a non-2xx as a transport failure and never
  reaches the terminal event, so a refusal must arrive as an error EVENT to read
  as a failed turn rather than an opaque one.
- **Re-origination is byte-identical to a native call.**
  `runtime-pi/sidecar/test/pi-messages-backend.test.ts` captures the request the
  sidecar originates through pi-ai's `onPayload` hook and compares it against
  the payload a direct call for the same backing produces, per protocol family.
  `runtime-pi/test/alias-dialect-opacity.test.ts` is its mirror on the other
  side: it builds the container model from `buildRuntimePiEnv`'s ACTUAL output
  and asserts the captured payload is identical across every backing vendor.
  Both are behavioral — this design transcribes nothing from pi-ai, so it must
  not acquire a source-text oracle that fires on cosmetic upstream
  reformatting.

One knob has to be restored on this side rather than forwarded: a classic
Anthropic call needs a request-scoped thinking budget, and `PiMessagesOptions`
models none. The rule lives in `anthropicThinkingBudgets`
(`@appstrate/core/model-generation`) and is applied by the runner on the direct
path and by the sidecar on the re-originated one.

Two fields deliberately do NOT cross: `toolChoice` (its value space differs per
vendor, so honouring it would mean the per-vendor mapping table this design
exists to avoid) and `debug` (which asks a backend for routing metadata about
itself — the one thing an alias boundary exists not to answer). Neither is
dropped in silence: `warnOnDiscardedRequestFields` logs the **set difference**
between what arrived and what this boundary forwards, so an option a future
pi-ai adds is reported the day it appears rather than vanishing with the tool
constraint the agent asked for. It warns rather than rejects — these fields are
advisory in practice, and failing the request would break every aliased run on a
pi upgrade. The log names fields only, never values or any model identifier:
sidecar logs are operator-visible and the alias contract holds there too.

## How resolution works

The alias **is** the registry `id`. Resolution (`org-models.ts`
`resolveModel`/`loadModel`) always returns the _real_ binding to the executor;
the alias never reaches upstream. Two layers hide the backing from users:

1. **Read projection** (`projectAliasedModel`) — strips the binding, pricing,
   context window, provider-native generation mappings, and every other
   identifying catalog field from user-facing reads. It keeps only the
   normalized portable generation support vector required for safe UI controls;
   unknown support is projected as unsupported. This vector can narrow the set
   of possible backing models, an accepted limitation of making aliases
   configurable without revealing their exact binding. The operator
   create/update responses keep the full shape.
2. **Inference-path handling** (`@appstrate/core/model-swap`) — different on the
   two paths, and the difference is the point:
   - the **sidecar** (agent runs) TERMINATES the container's canonical dialect
     and re-originates against the backing, so there is no alias left in a body
     to rewrite; and
   - the platform **LLM gateway** `/api/llm-proxy/*` (direct API/dashboard
     calls) PROXIES — its caller already speaks the backing's protocol — so it
     rewrites `model` alias→real on the request and real→alias on every
     response branch, including the cached body.

For an adaptive Anthropic backing, an agent-side Pi session cannot infer the
transport from the public alias id, so the run launcher records the fact on the
sidecar's private swap descriptor (`anthropicAdaptiveReasoning`). The sidecar
sets pi-ai's `compat.forceAdaptiveThinking` on the rebuilt Model and pi-ai emits
the adaptive shape itself, resolving the effort from the backing's own
`thinkingLevelMap`. Neither the backing id nor the adaptive flag enters the
agent container.

The usage ledger (`llm_usage`) keeps the real id privately in `real_model` for
billing/audit; the module-facing service accessor (`listLlmUsage`, exposed as
`PlatformServices.usage.list`) never projects `real_model`/`api`.

## Error surfaces: synthesize, never scrub

Success responses are rewritten by **exact field** (`model`, `message.model`,
`response.model`) — generated content is never touched. Error surfaces are
different: provider error bodies are free-form prose that can name the backing
anywhere (model id, hostname, provider vocabulary). For an aliased model they
are therefore **never forwarded at all** — each boundary REPLACES them with a
neutral synthesized envelope (`syntheticAliasErrorBody`):

```json
{
  "type": "error",
  "error": {
    "type": "upstream_error",
    "message": "Upstream model error (status 502)",
    "model": "<alias>"
  }
}
```

The alias is a STRUCTURED field, never part of `message`. An operator still
reads which model failed; the sentence a classifier consumes carries nothing
org-controlled. (`529` above became `502`: the status is projected before it is
disclosed — see the status table below.)

This is a whitelist by construction — a scrub would be a blacklist where every
forgotten surface is a new leak.

On the **gateway** (`/api/llm-proxy/*`), which proxies a real upstream response:

- **Non-2xx upstream bodies** → envelope at the upstream status; the original
  body goes to server logs (truncated).
- **Mid-stream SSE error frames** (Anthropic `type:"error"`, OpenAI-family
  standalone top-level `error`, OpenAI Responses `response.failed`/
  `response.incomplete` with a nested `response.error`) → replaced in-stream.
  Frames carrying `choices` are content and stay on the exact-field path.
- **Response headers** → reduced to the shared allowlist
  (`LLM_PASSTHROUGH_RESPONSE_HEADERS`: content-type, retry/RateLimit family,
  x-request-id); `server`, `cf-ray`, `anthropic-*`, `openai-organization`, …
  fingerprint the backing and are dropped.
- **Locally-synthesized messages** (protocol mismatch, SSRF refusal,
  OAuth-subscription rejection, credential label fallback) name the alias only;
  the backing detail is server-log-only.

On the **sidecar** there is no upstream response to sanitize — an aliased run
never receives one. Its three surfaces are all locally synthesized: a `404` for
a non-inference call on the narrowed `/llm/*` surface, a `400` for an unusable
`pi-messages` body, and the terminal `error` event described above.

**Retry survives the replacement, but the two boundaries preserve it
differently — and neither does it by "letting the headers flow".**

- On the **gateway**, the caller still gets an HTTP response: the upstream
  status is the response's own status, and `retry-after` / `RateLimit*` survive
  in `LLM_PASSTHROUGH_RESPONSE_HEADERS`. A client's normal retry logic works
  unchanged.
- On the **sidecar** nothing flows at all. `pi-messages` is a closed event union
  with no status line and no header channel, so a container CANNOT be told
  "429, retry in 12s" — there is no field for it. Retry is preserved in two
  other ways instead. (1) The sidecar owns the header-driven retry itself: it is
  the only side that can read `retry-after`, so it runs pi-ai's own bounded
  provider retry against the backing before reporting anything. (2) What the
  container is told is the STATUS, carried inside the synthesized message —
  `Upstream model error (status 429)`. That is not cosmetic: pi's
  `isRetryableAssistantError` classifies a failed turn by regex over exactly
  that string, so a status-less message reads as permanent and the container's
  turn-level retry budget never fires. See `syntheticAliasClassifierMessage`
  for why disclosing the integer costs no opacity (a status describes the
  transaction, not the vendor) — and why the ALIAS, which does not, is kept out
  of that same string.

Non-aliased models keep full verbatim passthrough (bodies, headers, hostnames)
— the opacity cost applies only to aliases, whose contract is precisely that
opacity. The trade-off: aliased callers lose upstream error detail (e.g. a
provider's "max_tokens too large" prose); the detail remains in server logs.

## Constraints

- **Body-`model` protocols only, and BACKING and CLIENT are separate sets.**
  `isAliasBackingShape` — the invariant `POST/PUT /api/models` and the env-seeded
  registry both check — admits exactly `anthropic-messages`,
  `openai-completions`, `openai-responses`, `openai-codex-responses`,
  `mistral-conversations` (`ALIAS_BACKING_SHAPES`). `google-*`, `azure-*`, and
  `bedrock-*` carry the model id in the URL path, so an alias there is
  **rejected** (it would forward the alias verbatim and 404). `pi-messages` is
  **not** a backing shape: it is the CLIENT dialect, matched by the separate
  `isAliasClientShape` / `ALIAS_CLIENT_API_SHAPE`. Because sidecar boot pins
  `clientApiShape` to that dialect, the inference allowlist is a single path
  (`POST /messages`).
- **API-key credentials only.** The oauth-subscription sidecar mode is a pure
  bearer-swap and never rewrites the body (`LlmProxyOauthConfig` carries no
  `modelSwap`), so an alias on an oauth-subscription credential is **rejected**
  at creation and at update (`oauth_provider` violation — the `POST` and `PUT`
  handlers of `/api/models` share the same invariant check), fail-closed at run launch
  (`assertOauthRunNotAliased`), and refused by the subscription chat resolver
  (a legacy aliased row falls to the LLM gateway, which rejects
  oauth-subscription models with an alias-safe message).
- **Explicit label required.** An alias must carry a label — the auto-derived
  label would name the backing model and survive the projection.

## Creating an alias

### 1. System (built-in) models — `SYSTEM_PROVIDER_KEYS` env

Add `"aliased": true` and an explicit `"label"` to a nested model entry. The
entry `id` is the public alias.

```jsonc
[
  {
    "id": "appstrate-deepseek",
    "providerId": "deepseek",
    "apiKey": "sk-...",
    "baseUrlOverride": "https://api.deepseek.com",
    "models": [
      {
        "id": "appstrate-medium", // public alias the user/agent sees
        "modelId": "deepseek-chat", // real upstream id (hidden)
        "label": "Appstrate Medium", // REQUIRED for aliases
        "aliased": true,
      },
    ],
  },
]
```

A misconfigured alias (no label, or a url-model protocol) is **skipped and
logged** at boot rather than registered half-working.

### 2. Custom (DB) models — `POST /api/models`

```jsonc
{
  "label": "Appstrate Medium", // REQUIRED for aliases
  "modelId": "deepseek-chat", // real upstream id (hidden)
  "credentialId": "<uuid>", // a body-model protocol credential
  "aliased": true,
}
```

The dashboard exposes no toggle to _create_ an alias (operator-only, by design);
the create/update API and `SYSTEM_PROVIDER_KEYS` are the two paths. Aliased
custom rows can be deleted in the UI but not edited (the projected binding can't
round-trip — edit via the API or env).

### 3. Hide the backing from the featured-models picker

The weekly `scripts/refresh-pricing-catalog.ts` regenerates the featured list.
Aliased **system-key** backings are excluded automatically. For **DB-row**
alias backings, add the real id to `FEATURED_MODELS_EXCLUDE` (comma-separated)
so the offline generator drops it:

```sh
FEATURED_MODELS_EXCLUDE="deepseek-chat,some-other-backing"
```

## Deployment ordering

The platform and the runtime images (`appstrate-pi`, the sidecar) implement two
halves of one contract. A version-tag trio rule now refuses the disagreement
outright: `findRuntimeImageTagMismatch` (`@appstrate/core/image-ref`, enforced by
the `@appstrate/env` schema) **fails boot** unless `PI_IMAGE` and `SIDECAR_IMAGE`
carry the same tag as each other and — whenever all three values are release
versions — as the platform's own `APP_VERSION`. So the ordinary released
deployment, the one pinned to `{{version}}` by the CLI, cannot reach either skew
below in either direction: it does not start.

The old-platform / new-images direction is safe on its own merits as well,
which is what keeps the exempt cases below benign in that direction: the
sidecar validates its private swap descriptor at boot and **fails closed**. An
OLD platform that does not yet emit `clientApiShape` / `backingApiShape` against
a NEW sidecar image gets its aliased runs refused, with the offending field
named in an operator log (never its value). Aliased runs stop; nothing leaks.
Non-aliased runs are unaffected — they carry no descriptor.

The reverse is the dangerous direction, and nothing but the tag rule detects it.
A NEW platform against OLD runtime images means the container is told to speak
`pi-messages` and the sidecar has no `pi-messages` backend to terminate it, and
the `/llm/*` surface allowlist is not there either — an old sidecar is a total
passthrough. The aliased run does fail, because its inference call has no route;
but it fails _after_ the container has had a verbatim proxy to the vendor's own
endpoints for as long as it lived, which is long enough for one
`GET /v1/models`. The platform's own side of the contract looks entirely
satisfied throughout, so there is no runtime signal to act on.

**Where ordering is still the only control.** The tag rule reads configuration
at boot, so it is blind wherever the tag stops identifying the build. Two of its
carve-outs are deliberate, and one gap is structural:

- **A digest-pinned `PI_IMAGE` or `SIDECAR_IMAGE`** silences the comparison
  outright — an operator pinning digests has taken explicit control of image
  identity, and takes this ordering rule with it.
- **A platform with no build identity** — `APP_VERSION` unset, empty, `dev` (a
  source run, a preview deployment) or any other non-release build stamp
  (`health-container-e2e`, what the health-container e2e job builds with) —
  drops out of the trio, degrading the rule to the pair rule. The two images are
  then still checked against each other, but not against the platform, which is
  precisely this section's direction.
- **Images pinned to an alias tag family.** `release.yml` publishes `latest`,
  `{{major}}.{{minor}}` and `sha-<sha>` for the same image as `{{version}}`, and
  `APP_VERSION` is a git ref name that can only ever equal a `{{version}}` tag.
  A deployment on any alias family is coherent, so the platform drops out there
  too — and the rule cannot order it. `:latest` on both refs is the case that
  matters: it is the documented compat fallback for consumers that skip the CLI,
  and it is indistinguishable, from configuration alone, from a hand-edited
  `.env` that floats the runtime images past a pinned platform.
- **A floating tag rebuilt on one side** (`:latest`) passes the comparison by
  construction: both tags are equal and only the bytes moved.
  `services/orchestrator/runtime-image-pair.ts` catches that case — and the one
  above with it — by comparing the images' `org.opencontainers.image.revision`
  stamps after the pre-pull, but it only **warns**, and it compares the pair to
  each other — never to the platform.

In all four, **ship the platform before or with the runtime images.**

## Threat A — what alias masking actually buys

This section used to say **"Closed."** That was false, and the falsehood was the
dangerous part: a reader planning a feature on top of aliases would have taken
"the org cannot learn the vendor" as a property they could rely on. It is not
one. What follows is the honest boundary.

### Status: the platform does not disclose the backing. It cannot conceal it.

**Vendor identity is not cryptographically or structurally concealed from a
caller who can send arbitrary prompts through an aliased model.** It is not a
matter of a leak still to be plugged — there is no version of this design in
which it is concealed, because the thing being hidden is the identity of the
system generating the text, and the caller is reading the text.

The order of magnitude, so nobody has to guess: published text-only
fingerprinting (LLMmap, USENIX Security 2025) identifies **42 model versions at
over 95% accuracy within 8 interactions**, using nothing but the response
strings — no headers, no timing, no token counts. Passive stylometry, with no
chosen prompts at all, separates five major vendors at 95%+. Against that, a
field rewrite on the response body is not a weak defence; it is not a defence.
Of the twelve published attack families in that literature, exactly **one** —
reading an identifying field out of the response envelope — is defeated by
hiding response fields. The other eleven read the generated text, the timing, or
the token boundaries.

So the requirement is stated the way the top of this page states it: **the
platform does not hand the backing over**. Not: the org cannot find out.

### What IS masked

Real, and worth keeping — each of these is a place the vendor's name would
otherwise appear in an Appstrate surface for free:

| masked                     | where                                                                           |
| -------------------------- | ------------------------------------------------------------------------------- |
| backing model id           | `projectAliasedModel` nulls `modelId`; `swapResponseModelJson` rewrites `model` |
| provider id / display name | `projectAliasedModel` nulls `providerId` / `providerName`                       |
| endpoint hostname          | `projectAliasedModel` nulls `baseUrl`; the gateway originates the upstream call |
| rate card / context window | `projectAliasedModel` nulls `cost`, `contextWindow`, `maxTokens`                |
| protocol family on the DTO | `projectAliasedModel` nulls `apiShape` (but see the oracle below)               |
| provider error prose       | replaced wholesale by `syntheticAliasErrorBody` — never forwarded               |
| vendor response headers    | reduced to `LLM_PASSTHROUGH_RESPONSE_HEADERS`                                   |
| the agent container's env  | pinned as an exact set by `packages/runner-pi/test/alias-env-allowlist.test.ts` |

The env surface is the one item on this list with a **CI gate**, and that is why
it is the one item that stays closed as the code moves: any new variable fails
the test until someone adds it deliberately.

Two surfaces were added to that list by the same change that made this page
honest, both on `/api/models` and both reachable with `models:write` (an
admin/owner grant, or an API key minted with the scope):

- **`PUT /api/models/{id}` now projects its response.** It returned
  `getOrgModel()` raw, so a no-op `PUT {"enabled":true}` answered with
  `providerId`, `providerName`, `baseUrl`, `apiShape`, `contextWindow` and
  `cost`. Its only guard was `isSystemModel`, which rejects env-declared models
  and says nothing about a DB-row alias. The asymmetry with `POST` is kept
  deliberately: a create response echoes a binding the operator just sent, an
  update response discloses one the caller never held.
- **`POST /api/models/{id}/test` now refuses an alias** with a 400, before any
  fetch. It issued a live `GET {realBaseUrl}/models` on the platform credential
  and returned `{ ok, latency, status }` — the backing's own round-trip time and
  upstream HTTP status, i.e. two oracles and an unmetered spend of a platform
  credential. The dashboard hides the button for aliased rows to match.

Neither was a fingerprinting attack; both simply handed the binding over. They
are the kind of leak worth fixing precisely because they are cheap to fix.

### What is NOT masked

Ordered by how cheap the attack is. The first item needs no prompt at all.

1. **The `apiShape` route-family oracle — structural, pre-prompt, ~3 requests.**
   The gateway mounts one route per protocol family from `LLM_PROXY_ROUTES`
   (`packages/runner-pi/src/llm-proxy-routes.ts:63`) — `openai-completions`,
   `anthropic-messages`, `mistral-conversations`. `resolvePresetForOrg`
   (`apps/api/src/services/llm-proxy/core.ts:358`) rejects a preset whose real
   `apiShape` is not the route's, so posting the same alias id to each route in
   turn answers "wrong family" (400) on all but one. The 400's _message_ is
   masked for an alias — `LlmProxyModelApiMismatchError` deliberately omits
   `actual` — but masking the message does not mask the **signal**: 400-versus-
   proceed is itself the answer, and three families are separated in at most
   three requests (two, then inference by elimination). The repo's own
   `apps/api/test/integration/routes/llm-proxy.test.ts` asserts both halves of
   that oracle, one test apart, while believing it closed.
   `projectAliasedModel` nulling `apiShape` on the DTO does not touch it. **The
   permission required is `llm-proxy:call`, which is an ordinary
   `MEMBER_PERMISSIONS` grant** (`apps/api/src/lib/permissions.ts:191`) — not an
   admin capability. Any member of the org can run this.

2. **Response body fields outside `model`.** `rewriteModelRealToAlias`
   (`packages/core/src/model-swap.ts:83`) rewrites keys literally named `model`,
   at three fixed locations (top level, `message`, `response`). Every other key
   in a 2xx body is forwarded verbatim, including ones that name the vendor
   outright by their own key name: OpenAI's `system_fingerprint` and
   `service_tier`, the `id` prefix (`chatcmpl-` vs Anthropic's `msg_`), and
   DeepSeek's top-level `prompt_cache_hit_tokens` — which the metering code
   already reads (`apps/api/src/services/llm-proxy/openai.ts:67`), so it is
   known to arrive. These are the cheap ones, and they are gifts: they identify
   the vendor with no statistics and no chosen prompts.

   Closing them is a **denylist over a set nobody can enumerate** — that set is
   a property of the vendors' live APIs, not of this source — which is exactly
   the argument the canonical-dialect section makes for the sidecar. It is worth
   trimming the known gifts anyway; it is not worth believing the trim is a
   boundary. (Note that `google-*`, `azure-*` and `bedrock-*` cannot be alias
   backings at all — `isAliasBackingShape` rejects them — so Google's
   `modelVersion`, the textbook case of an identifying key not named `model`,
   is out of scope here by construction rather than by masking.)

3. **SSE frame structure.** The gateway proxies the upstream stream. Anthropic
   emits `message_start` / `content_block_delta` / `message_delta`; the OpenAI
   families emit `chat.completion.chunk` objects with `choices[].delta`. The
   event names and the frame shape are the protocol, and they are not rewritten.
   This is a restatement of (1) that does not even need the probe requests.

4. **Inter-token timing.** Time-to-first-token and sustained inter-token latency
   are stable per backing at a given load. Nothing in the proxy path normalises
   them, and normalising them would mean buffering the stream, which is the
   feature.

5. **Tokenizer boundaries.** `usage.input` for a controlled probe string is a
   tokenizer fingerprint — a fixed probe tokenizes to a different integer under
   each vocabulary, and a handful of probes separates the families. The count is
   load-bearing for billing on this path exactly as it is for the container
   (see tier 2 below): it cannot be withheld.

6. **Stylometry and direct interrogation.** The caller can ask the model who it
   is, and can fingerprint refusal style, formatting tics, and system-prompt
   behaviour. This is item (1) of the LLMmap result and needs no platform
   surface at all.

Items 3–6 are the same irreducible tier as
"[Threat B in two tiers](#threat-b-in-two-tiers)" §Tier 2, reached through a
different door. The split in that section — _what the platform discloses_ versus
_what an observer can infer_ — is the right frame for Threat A too, and this
section is that frame applied to the gateway/dashboard caller.

### Market context

**No commercial LLM gateway claims vendor opacity.** OpenRouter, LiteLLM,
Portkey, Cloudflare AI Gateway, Kong, Braintrust, Vercel AI Gateway and AWS
Bedrock all disclose the upstream vendor — most of them advertise it as a
feature, because "you can see and choose the provider" is what a gateway sells.

The most instructive case is Bedrock, because AWS built the industry's most
complete normalisation layer and then documented its limit. The Converse API
works, in AWS's own description, by **dropping most model-native fields by
default** — and AWS then shipped `additionalModelResponseFieldPaths`, an escape
hatch that reads arbitrary JSON Pointers into the vendor's untouched native
response. The normalised view is a convenience, not a boundary, and the vendor's
own payload is still there behind it. That is the same shape as this design's
`model`-only rewrite, with a decade more engineering behind it.

Nobody sells this property. That is evidence about the property, not about the
competition.

### So what is alias masking FOR?

It is worth having. It is not worth misdescribing.

**Good for:**

- **Casual inspection.** The dashboard, the model picker and the run detail show
  `Appstrate Medium`, not `deepseek-chat`. The overwhelming majority of users
  never probe anything, and for them the abstraction simply holds.
- **Dashboard and API hygiene.** A vendor name does not appear in a payload a
  customer's own tooling stores, screenshots, or pastes into a ticket.
- **Not leaking a vendor name by accident.** The real value: a customer's logs,
  a run's error surface, an exported artefact — none of them acquire a vendor
  name because a field happened to ride along. The error-synthesis and header-
  allowlist work in this document is what buys that, and it buys it reliably.
- **Product framing.** Appstrate can re-point `appstrate-medium` at a different
  backing without breaking a caller's configuration. That is a real capability
  and it is independent of whether the old backing was identifiable.

**Not good for:**

- **Contractual or compliance non-disclosure.** If a customer contract, a
  subprocessor list, or a regulatory position depends on the vendor being
  unknowable to the customer, this mechanism does not provide it and no
  extension of it will. That has to be handled in the contract.
- **Defence against a motivated adversary.** An org member with `llm-proxy:call`
  and an afternoon identifies the backing. Assume any org that wants to know,
  knows.
- **Any security property.** Nothing in the platform's authorization or tenancy
  model may be built on the assumption that the backing is secret.

### Tracked: the `apiShape` oracle is not closed

Closing item (1) above is a **product-visible API change** and is deliberately
NOT shipped in the change that made this page honest. The two candidate designs,
what each breaks, and the recommendation are in the design note immediately
below. It is open work, not a decision already taken.

#### Design note — closing the route-family oracle (not implemented)

Two options, both real, neither free.

**Option 1 — refuse aliases on the vendor-shaped gateway routes.**
`resolvePresetForOrg` gains an alias check before the `apiShape` comparison and
rejects any aliased preset with a single neutral error, identically on all three
routes. Files: `apps/api/src/services/llm-proxy/core.ts` (the check),
`apps/api/src/openapi/paths/llm-proxy.ts` (document the refusal),
`apps/api/test/integration/routes/llm-proxy.test.ts` (the existing masking test
becomes a refusal test).

- Closes the oracle completely: every route answers the same thing, so there is
  no signal to difference.
- **Breaks**: aliased models stop working through `/api/llm-proxy/*` entirely —
  the direct API path, `appstrate run` against a remote instance, and the
  GitHub Action. Anything that is not an agent run in a container loses aliases.
  That is a capability removal, not a hardening.

**Option 2 — serve one closed client dialect on the gateway.** Mount a single
alias route speaking `pi-messages` — the vendor-neutral dialect the sidecar
already terminates and re-originates — and refuse aliases on the three
vendor-shaped routes. Files: `apps/api/src/routes/llm-proxy.ts` (mount),
a new gateway-side `pi-messages` backend mirroring
`runtime-pi/sidecar/pi-messages-backend.ts`, plus the same three files as
Option 1.

- Closes the oracle **and** items (2) and (3): a closed event union carries no
  vendor vocabulary and no vendor frame shape, by construction rather than by
  denylist. It is the design this document already argues for on the sidecar
  side, applied to the second inference path.
- **Breaks**: every existing gateway caller of an aliased model must change
  protocol — they currently speak the backing's own dialect and would have to
  speak `pi-messages`. It also duplicates the sidecar's projection logic on the
  platform, or requires extracting it into a shared module.
- Leaves items (4)–(6) untouched, as any design does.

**Recommendation: Option 2, staged** — mount the `pi-messages` alias route
first, migrate callers, and only then refuse aliases on the vendor-shaped
routes, so the capability is never absent. Extract the projection from
`runtime-pi/sidecar/pi-messages-backend.ts` into a shared module rather than
mirroring it; two copies of a whitelist projection is precisely the drift this
document warns about elsewhere.

**Do not do either one silently.** Both change what an existing API caller can
do, so both need the API-versioning and deprecation path, not a patch release.

Until then, this page says the oracle is open, because it is.

## Threat B in two tiers

Collapsing these two is what made the requirement unwritable in the first
place, because they are different kinds of claim. The first is a property of
this codebase, enumerable and CI-gated. The second is a property of talking to
a language model at all, and no plumbing anywhere touches it.

### Tier 1 — what the platform discloses (closed)

Everything an aliased run's container is handed, and nothing else:

| reaches the container                       | example (aliased `Appstrate Flash`) | effect                                          |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `MODEL_API`                                 | `pi-messages`                       | the same for every alias — names nothing        |
| `MODEL_ID`                                  | `appstrate-flash`                   | the public alias the caller already chose       |
| `MODEL_BASE_URL` / `MODEL_API_KEY`          | sidecar URL / placeholder           | neither reaches upstream                        |
| `MODEL_CONTEXT_WINDOW` / `MODEL_MAX_TOKENS` | `200000` / `64000`                  | the backing's exact numbers — narrows it        |
| `MODEL_INPUT`                               | `["text","image"]`                  | already published by the read projection        |
| success response body                       | `text_delta`, `done`                | closed pi-messages union — no vendor vocabulary |
| signature fields on that body               | `redacted: true`                    | opaque values, but not every backing emits them |

`MODEL_PROVIDER`, `MODEL_REASONING_LEVEL_MAP` and `MODEL_COST` are **not**
emitted for an alias. The provider key and the native effort table name the
vendor outright; a published `{"input":0.28,"output":0.42}` is one catalog
lookup from a vendor name. The container reports **no cost** in return, not a
fabricated `0` — the ledger reads a null reported cost as "nothing to compare"
and prices the row itself from `runs.model_cost` × the reported token counts, so
what the sandbox knows does not determine what is billed.

The narrowed `/llm/*` surface is what keeps the disclosure list to that table.
An aliased run gets exactly ONE call — the inference endpoint its client
protocol uses — `POST /messages` (`isAliasInferenceCall`). Everything
else is refused with the neutral envelope at 404, before any upstream fetch and
before the placeholder is swapped for the real key, so the credential is never
spent on a request being rejected. Without that narrowing a single
`GET /v1/models` returns the vendor's own catalogue in a **2xx** body, which
neither the error synthesis (non-2xx only) nor any field rewrite looks at.
Non-aliased runs keep the verbatim passthrough; their contract is reaching the
provider, not hiding it.

Three values are sent **exact** rather than masked or withheld, each because
masking costs something real and buys nothing measurable:

- the two token limits — the container sizes its compaction pass from them
  (`derivePiCompactionSettings`), and an absent value lands on per-code-path
  defaults that disagree. Rounding them would not close the tokenizer
  fingerprint in `usage.input` (tier 2), which separates the vendor families
  outright on its own;
- `MODEL_INPUT` — dropping it does not degrade gracefully, it silently disables
  image input for the whole run, and the modality vector is already disclosed on
  purpose by the read projection.

Five fields of the response body are **known residuals** — on the list because
they must be, not because they are neutral:

| field                           | emitted by                                                                                      | narrows the backing to                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `thinking_end.redacted`         | the Anthropic adapter alone — it is how safety-filtered thinking travels as `redacted_thinking` | `anthropic-messages` (1 of 5)                          |
| `toolCall.thoughtSignature`     | `openai-completions`, and the Google shapes, which cannot back an alias                         | `openai-completions` (1 of 5)                          |
| `text_end.contentSignature`     | the shared openai-responses adapter                                                             | `openai-responses` / `openai-codex-responses` (2 of 5) |
| `toolCall.namespace`            | the same adapter                                                                                | the same two (2 of 5)                                  |
| `thinking_end.contentSignature` | every backing shape but `mistral-conversations`                                                 | 4 of 5 — here the tell is its absence                  |

Their VALUES are opaque blobs and nothing is read out of them; it is their mere
PRESENCE that narrows the candidate vendor. That is the same argument by which
`projectUsage` drops `Usage.cacheWrite1h` and `Usage.reasoning`, which are NOT
kept. The difference is that these five round-trip: pi-ai's `pi-messages` reader
writes each one back onto the container's own assistant message, the container
replays that message in the next turn's context, and the sidecar re-originates it
against the backing — where the Anthropic adapter reads `thinkingSignature` back
out as `signature`, or as `redacted_thinking` when `redacted` is set. Dropping
them does not mask the vendor, it fails multi-turn extended thinking upstream, at
the vendor, with an error naming none of this.

Closing this properly means relocating the fields rather than dropping them: the
sidecar would hold each signature itself, keyed by `(sessionId, contentIndex)`,
and hand the container an opaque handle in its place — swapping the real value
back in when that content block returns in a later request. The container would
then see one uniform handle shape whatever backs the alias, which is a real
closure rather than a smaller leak. The cost is per-session sidecar state with a
lifetime, an eviction policy, and a new failure mode — a handle the sidecar has
forgotten — sitting on the path extended thinking depends on. It has not been
done. This page says so rather than letting the closed union imply the reply
carries nothing.

What keeps tier 1 closed is not this page.
`packages/runner-pi/test/alias-env-allowlist.test.ts` pins the COMPLETE set of
variables an aliased container receives as an exact set, and pins the
non-aliased set beside it so the assertion states the difference rather than one
side of it. Any new variable fails it until someone adds it deliberately.

That file also pins the one combination the env contract refuses outright:
`buildRuntimePiEnv` throws on `aliased` + `noSidecar`, because the sidecar IS
the masking and the no-sidecar path would otherwise put the backing's own
hostname in `MODEL_BASE_URL`.

`runtime-pi/sidecar/test/pi-messages-backend.test.ts` does the same for the
reply: it pins the exact field set `projectAssistantEvent` emits for every member
of the event union, in both directions. A new vendor-revealing field cannot join
the residual list above without someone adding it there and answering for it, and
a round-tripping one cannot silently vanish.

### Tier 2 — what an observer can infer (irreducible)

None of the following is closed, and none of it will be. An organization
running an agent controls the code inside the container and the prompt going to
the model, so it can measure the model itself.

- **Ask it.** An agent can simply ask the model who it is. It can also
  fingerprint the shape of a refusal, the house style of a system-prompt
  leak attempt, or the tics of a long generation.
- **Time it.** Time-to-first-token and sustained throughput are stable enough
  per backing, at a given load, to separate candidates.
- **Count its tokens.** This is the one that is easy to miss, because it looks
  like accounting rather than identity. The terminal `done` event carries
  `usage`, and `usage.input` for a controlled prompt _is_ a tokenizer
  fingerprint: a fixed probe string tokenizes to a different integer under each
  vocabulary, and a handful of probes separates the families outright. Nothing
  here touches it, and nothing should: the count is load-bearing
  on both sides of the boundary — the container sizes its next compaction from
  it, and the platform prices `llm_usage.cost_usd` from it. Withholding it
  would break compaction and billing to buy an inference the org can also get by
  asking the model to count.
- **Read the limits.** `MODEL_CONTEXT_WINDOW` / `MODEL_MAX_TOKENS` are the
  backing's real numbers, so a pair can be looked up in a public catalog. It
  narrows the candidate set. It does not close it, and it tells an observer
  nothing the token counts above do not already.
- **Read the modality vector.** `MODEL_INPUT` / the read projection publish it
  on purpose, and it narrows the set too.

That is the honest boundary this page opened with, and it is the reason the
requirement is stated the way it is: the platform does not disclose the backing.
It cannot make an organization unable to find out.
