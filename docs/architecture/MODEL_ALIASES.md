# Model Aliases (LLM-gateway alias pattern)

Issue: appstrate#727

A **model alias** exposes a model under an Appstrate-branded vanity name (e.g.
`appstrate-medium`) while the real backing model (e.g. `deepseek-chat` on some
provider) stays hidden server-side. This is the same pattern LiteLLM, Portkey,
OpenRouter, and Kong call a _model alias_ / _virtual model_: a public name with
a private binding, rewritten on the inference data path.

## What an alias hides — and from whom

There are two threat models. The implementation closes the first and reduces
the second.

- **Threat A — the dashboard / API caller.** A user reading `/api/models`, a run
  detail, or calling `/api/llm-proxy/*` must never learn the backing
  provider/endpoint/model id. **Closed.**
- **Threat B — the agent runtime (adversarial code inside the container).** The
  agent needs _some_ protocol/endpoint info to format requests, so the backing
  cannot be perfectly hidden from determined in-container code. **Reduced, not
  eliminated** — the real `model` id, real upstream id in responses, and error
  prose are swapped/scrubbed, but `MODEL_API` (protocol family) remains
  observable.

## How resolution works

The alias **is** the registry `id`. Resolution (`org-models.ts`
`resolveModel`/`loadModel`) always returns the _real_ binding to the executor;
the alias never reaches upstream. Two layers hide the backing from users:

1. **Read projection** (`projectAliasedModel`) — strips the binding + every
   catalog-derived capability/cost field (they fingerprint the real model) from
   user-facing reads. The operator create/update responses keep the full shape.
2. **Inference-path swap** (`@appstrate/core/model-swap`) — rewrites the `model`
   field alias→real on the request and real→alias on the response, on **both**
   inference paths:
   - the in-container **sidecar** proxy (agent runs), and
   - the platform **LLM gateway** `/api/llm-proxy/*` (direct API/dashboard
     calls).

The usage ledger (`llm_usage`) keeps the real id privately in `real_model` for
billing/audit; the only service accessor (`listLlmUsageForRun`) projects just
`id`/`costUsd`/`source`.

## Constraints

- **Body-`model` protocols only.** The swap rewrites the `model` field in the
  JSON body, which exists for `anthropic-messages`, `openai-completions`,
  `openai-responses`, `openai-codex-responses`, `mistral-conversations`.
  `google-*`, `azure-*`, and `bedrock-*` carry the model id in the URL path, so
  an alias there is **rejected** (it would forward the alias verbatim and 404).
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

The container still receives `MODEL_API` (the protocol family) and reaches the
real endpoint through the sidecar. An adversarial agent can infer the _protocol_
but not the real `model` id, the upstream id echoed in responses, the endpoint
host, or the credential. Closing Threat B fully would require a protocol-
normalizing gateway and is out of scope here.
