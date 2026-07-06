# Architecture

Design notes for Appstrate's internal subsystems. Each document is the canonical
reference for its topic — the code and top-level `CLAUDE.md` link here rather than
duplicating the detail.

## Run execution

- [**FIRECRACKER.md**](./FIRECRACKER.md) — Firecracker execution backend (`RUN_ADAPTER=firecracker`). One microVM per run behind a KVM hardware boundary; the platform → `appstrate-runner` host-daemon split. Opt-in built-in module.
- [**SIDECAR.md**](./SIDECAR.md) — Sidecar protocol. Credential-isolating MCP server that injects secrets the agent never sees.
- [**INTEGRATIONS_RUNTIME.md**](./INTEGRATIONS_RUNTIME.md) — AFPS integrations runtime: per-integration runner containers, MITM credential proxy, remote HTTP/SSE MCP transport.
- [**RUN_COST.md**](./RUN_COST.md) — Run cost tracking. The `llm_usage` ledger and single `computeRunCost` read path.

## Models & providers

- [**MODEL_ALIASES.md**](./MODEL_ALIASES.md) — LLM-gateway model-alias pattern (masking real model ids across the two inference paths).
- [**SUBSCRIPTION_COMPLIANCE.md**](./SUBSCRIPTION_COMPLIANCE.md) — Subscription credential compliance posture for the opt-in codex / claude-code provider modules.

## Platform posture

- [**OBSERVABILITY.md**](./OBSERVABILITY.md) — OpenTelemetry traces, metrics, and logs.
- [**SUPPLY_CHAIN.md**](./SUPPLY_CHAIN.md) — Supply-chain posture for the single-vendor Pi SDK dependency.

---

Env vars → [`../ENV.md`](../ENV.md) · Casing policy → [`../CASING_CONVENTIONS.md`](../CASING_CONVENTIONS.md)
