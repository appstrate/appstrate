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
  detail, or calling `/api/llm-proxy/*` must never learn the backing
  provider/endpoint/model id. **Closed.** The read projection leaves only the
  alias identity plus the portable generation-support vector (see
  `projectAliasedModel`); every binding, pricing and catalog field is `null`.
- **Threat B — the agent runtime (adversarial code inside the container).**
  **Closed for the request/response surface — appstrate#1198.** The agent needs
  _some_ protocol information to format requests, and this used to mean the
  container spoke the vendor's own dialect. It no longer does: an aliased run's
  container speaks **`pi-messages`**, pi-ai's own vendor-neutral protocol, and
  the sidecar re-originates the call against the real backing (see
  "The canonical dialect" below). This was never merely a sandbox-escape
  concern — the agent's own logs are an Appstrate surface, so an org member who
  prints the container env reads whatever is in it from the dashboard.

  | reaches the container                       | example (aliased `Appstrate Flash`) | effect                                          |
  | ------------------------------------------- | ----------------------------------- | ----------------------------------------------- |
  | ~~`MODEL_PROVIDER`~~                        | —                                   | **no longer emitted** (appstrate#1198)          |
  | `MODEL_API`                                 | `pi-messages`                       | the same for every alias — names nothing        |
  | ~~`MODEL_REASONING_LEVEL_MAP`~~             | —                                   | **no longer emitted** (appstrate#1198)          |
  | `MODEL_CONTEXT_WINDOW` / `MODEL_MAX_TOKENS` | `196608` / `8192`                   | narrows it — rounded, see below                 |
  | success response body                       | `text_delta`, `done`                | closed pi-messages union — no vendor vocabulary |

  `MODEL_COST` is **no longer sent at all** for an aliased run. The published
  per-token rate card identifies the vendor on its own, and nothing depends on
  the container knowing it any more: `writeRunnerLedgerRow` computes the
  runner's `llm_usage.cost_usd` server-side from `runs.model_cost` × the
  reported token counts, so what the sandbox knows stopped determining what is
  billed. The container then reports **no cost**, not a fabricated `0` — the
  ledger reads a null reported cost as "nothing to compare" and prices the row
  itself either way.

  The two token limits are **rounded down, not dropped**. The container really
  needs them (`derivePiCompactionSettings` sizes the compaction pass from them,
  and an absent value lands on per-code-path defaults that disagree), so
  `maskAliasedTokenLimits` (`@appstrate/core/model-swap`) puts them on a ladder
  of 16 buckets per binary octave: down only — `maxTokens` reaches the upstream
  as the response cap and rounding it UP would produce a 400 that the neutral
  error envelope makes undiagnosable — never producing `maxTokens >=
contextWindow`, which `deriveResponseReserveTokens` treats as corrupt data,
  and losing under 6.25 % so compaction is not materially degraded. Be precise
  about what this buys: it removes the _exactness_ that lets a pair be looked up
  in a public catalog. It narrows the candidate set; it does not close it. The
  **sidecar** keeps the REAL numbers — it is trusted, and its token-budget guard
  on MCP tool results protects against the real upstream limit, so rounding
  there would be a correctness regression rather than extra safety.

  The `/llm/*` **surface** is no longer part of the hole either. For an
  aliased run the sidecar allows exactly one call — the inference endpoint the
  run's own protocol family uses (`ALIAS_INFERENCE_PATHS` /
  `isAliasInferenceCall` in `@appstrate/core/model-swap`, the same table the
  platform gateway derives its `upstreamPath` values from). Anything else —
  `GET /v1/models` above all, which returns the vendor's catalogue in a **2xx**
  body that neither the error synthesis nor the `model`-field rewrite looks at
  — is refused with the neutral `syntheticAliasErrorBody` envelope at 404,
  before any upstream fetch and before the real credential is injected.
  Non-aliased runs keep the verbatim passthrough; their contract is reaching
  the provider, not hiding it.

  The response path is NOT the hole: headers are reduced to
  `LLM_PASSTHROUGH_RESPONSE_HEADERS`, error surfaces are synthesized rather
  than forwarded, and the `model` field is swapped back to the alias. The hole
  is the request-side metadata above, and the fact that the container formats
  requests in the vendor's own dialect.

  What remains is not the dialect. It is the residue listed under "Residual
  exposure" below: the rounded token limits, the modality vector the read
  projection discloses on purpose, and everything an agent can infer by asking
  the model who it is.

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

The **sidecar** is the `pi-messages` backend. `POST /llm/messages` — inside the
same `/llm/*` handler the surface allowlist already guards, reusing its
placeholder→real-key swap and SSRF check — deserialises `{model, context,
options}`, rebuilds the REAL backing's pi-ai `Model` record from the private
swap descriptor, calls pi-ai's own `streamSimple`, and projects the resulting
`AssistantMessageEvent`s down to `PiMessagesEvent`s. **No quirk table is
mirrored anywhere**: `detectCompat` and every per-vendor serializer keep running
inside pi-ai, one process to the left of the container. The projection is a
whitelist (each outbound event built field by field, never a spread) because
pi-ai's `partial` carries `api`, `provider` and the real model id on every
single event, and because a spread would ship the next pi-ai version's new field
to the container silently.

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
  REPLACED with `syntheticAliasErrorMessage`, same whitelist posture as every
  other alias error surface. The response stays `200 + SSE` even on failure:
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
2. **Inference-path swap** (`@appstrate/core/model-swap`) — rewrites the `model`
   field alias→real on the request and real→alias on the response, on **both**
   inference paths:
   - the in-container **sidecar** proxy (agent runs), and
   - the platform **LLM gateway** `/api/llm-proxy/*` (direct API/dashboard
     calls).

For an adaptive Anthropic backing, an agent-side Pi session cannot infer the
transport from the public alias id, so the run launcher records the fact on the
sidecar's private swap descriptor (`anthropicAdaptiveReasoning`). Each boundary
then uses it the way its own path needs: the PROXY path rewrites the container's
classic body into `thinking.type: "adaptive"` + `output_config.effort` while
swapping the request model, and the RE-ORIGINATION path (every aliased agent
run) instead sets pi-ai's `compat.forceAdaptiveThinking` on the rebuilt Model so
pi-ai emits the adaptive shape itself, resolving the effort from the backing's
own `thinkingLevelMap`. Neither the backing id nor the adaptive flag enters the
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
    "message": "Upstream model error (model \"<alias>\", status 529)"
  }
}
```

This is a whitelist by construction — a scrub would be a blacklist where every
forgotten surface is a new leak. Concretely:

- **Non-2xx upstream bodies** (sidecar + gateway) → envelope at the upstream
  status; the original body goes to server logs (truncated).
- **Mid-stream SSE error frames** (Anthropic `type:"error"`, OpenAI-family
  standalone top-level `error`, OpenAI Responses `response.failed`/
  `response.incomplete` with a nested `response.error`) → replaced in-stream.
  Frames carrying `choices` are content and stay on the exact-field path.
- **Fetch-level failures** (ConnectionRefused / DNS / TLS, sidecar-synthesized 502) → the error `code` survives, the `(hostname)` hint is dropped.
- **Response headers** → reduced to the shared allowlist
  (`LLM_PASSTHROUGH_RESPONSE_HEADERS`: content-type, retry/RateLimit family,
  x-request-id); `server`, `cf-ray`, `anthropic-*`, `openai-organization`, …
  fingerprint the backing and are dropped.
- **Locally-synthesized gateway messages** (protocol mismatch, SSRF refusal,
  OAuth-subscription rejection, credential label fallback) name the alias only;
  the backing detail is server-log-only.

Status codes and the retry/backoff headers still flow, so client retry
behavior is preserved. Non-aliased models keep full verbatim passthrough
(bodies, headers, hostnames) — the opacity cost applies only to aliases, whose
contract is precisely that opacity. The trade-off: aliased callers lose
upstream error detail (e.g. a provider's "max_tokens too large" prose); the
detail remains in server logs.

## Constraints

- **Body-`model` protocols only.** The swap rewrites the `model` field in the
  JSON body, which exists for `anthropic-messages`, `openai-completions`,
  `openai-responses`, `openai-codex-responses`, `mistral-conversations`.
  `google-*`, `azure-*`, and `bedrock-*` carry the model id in the URL path, so
  an alias there is **rejected** (it would forward the alias verbatim and 404).
  `pi-messages` is in the aliasable set too — its body also carries a top-level
  `model` — but it appears there as a possible BACKING; it is separately the
  protocol every aliased container speaks, whatever the backing is.
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

## Residual exposure (Threat B)

The container receives `MODEL_API=pi-messages` — the same value for every alias,
so it names nothing — and reaches the sidecar's one `POST /messages`. It does
not receive the vendor, the protocol family, the native effort mapping, the rate
card, the real `model` id, the upstream id echoed in responses, the endpoint
host, or the credential. Its token limits are rounded onto a shared ladder
rather than handed over verbatim.

What is left is not plumbing. An agent can ask the model who it is, fingerprint
its tokenizer, time its latency, probe its refusal style — and the rounded
limits plus the disclosed modality vector still narrow the candidate set. That
is the honest boundary this page opened with: the platform does not disclose the
backing; it cannot make an org unable to find out.
