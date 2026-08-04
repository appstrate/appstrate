# Model runtime canary

The model runtime canary validates inference, not just credentials or a model
listing endpoint. Every probe follows the same critical path as an agent run:

```text
effective SYSTEM_PROVIDER_KEYS model
  → runtime-pi model construction
  → Pi SDK request adapter
  → Hono sidecar (/llm)
  → pinned upstream provider/model
```

The provider is the only external boundary. Fallbacks are disabled, Pi retries
are disabled, and only transient `408`, `429`, or `5xx` results are retried once
by the canary coordinator. A backup model can therefore never turn a broken
target into a green result.

## Token budget

- Standard models: at most 4 output tokens.
- Reasoning models: at most 16 output tokens, because hidden reasoning can
  consume the entire completion budget before any text appears.

Success means that the target accepts the request and returns a valid Pi stream.
The canary does not assert exact generated text.

## Configuration

Set the GitHub Actions secret `MODEL_RUNTIME_CANARY_CONFIG` to a JSON array using
the `SYSTEM_PROVIDER_KEYS` schema. Use dedicated low-quota keys rather than
production credentials. List every system alias and every featured model that
must stay deployable.

```json
[
  {
    "id": "canary-deepseek",
    "providerId": "deepseek",
    "apiKey": "dedicated-canary-key",
    "models": [
      {
        "id": "appstrate-flash",
        "modelId": "deepseek-v4-flash",
        "label": "Appstrate Flash",
        "aliased": true
      }
    ]
  }
]
```

The secret is intentionally required and never exposed to `pull_request`
workflows. A missing secret makes trusted live gates fail closed.

## Gates

1. Every PR runs the hermetic Pi → sidecar → fake-provider regression suite.
2. The weekly catalog refresh probes configured models whose capabilities,
   context window, or maximum output changed before opening its PR. Price-only
   changes do not trigger inference.
3. `Model runtime canary` probes every configured model nightly.
4. A deployment system can dispatch the `model-runtime-deployed`
   `repository_dispatch` event after promotion to run the same uncached
   all-model probe.

Run it locally or inside a trusted deployment environment:

```sh
MODEL_RUNTIME_CANARY_CONFIG='[...]' bun run canary:models
MODEL_RUNTIME_CANARY_CONFIG='[...]' bun run canary:models:changed
```

The report contains provider/model ids, target status, latency, and observed
token usage. It never prints API keys.

## Scope

The raw pricing catalog currently contains hundreds of entries. Live-probing
all of them on every PR would require credentials for every provider, create
rate-limit noise, and spend tokens on models the deployment does not serve.
The exhaustive live set is therefore the explicit canary configuration; the PR
suite remains exhaustive over deterministic protocol variants.

BYOK credentials stay organization-owned. Their existing connection test is a
credential/model-list check, not a runtime inference canary; operators can add a
dedicated credential to the canary config when they need continuous coverage.
