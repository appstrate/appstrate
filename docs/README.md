# Appstrate documentation

Reference documentation for developing, operating and extending Appstrate.
Start at [`../README.md`](../README.md) for what Appstrate is and how to install
it; start here when you need the detail behind a subsystem.

## Reference

- [**ENV.md**](./ENV.md) — every environment variable, with defaults and notes. Kept in sync with the `@appstrate/env` Zod schema, which is the source of truth.
- [**CASING_CONVENTIONS.md**](./CASING_CONVENTIONS.md) — the snake_case-on-the-wire / camelCase-internal policy and its documented carve-outs.

## Architecture

Design notes for the internal subsystems — see [`architecture/`](./architecture/README.md)
for the full index: run execution (Firecracker, sidecar, integrations runtime,
run cost), files, model providers, and platform posture (observability,
supply chain).

## Guides

- [**guides/configuring-agent-resources.md**](./guides/configuring-agent-resources.md) — configure operator ceilings and author portable per-run memory/CPU hints.
- [**guides/writing-an-integration-with-connect.md**](./guides/writing-an-integration-with-connect.md) — build an AFPS integration that authenticates through Connect.
- [**guides/connecting-mcp-clients.md**](./guides/connecting-mcp-clients.md) — point an external MCP client (Claude Code, Cursor, …) at an Appstrate instance.

## CLI

- [**cli/upgrades.md**](./cli/upgrades.md) — upgrade paths for the `appstrate` binary across install channels, and how to recover from a dual install.

See [`../apps/cli/README.md`](../apps/cli/README.md) for the command reference and
[`../apps/cli/AGENTS.md`](../apps/cli/AGENTS.md) for driving the CLI as an AI agent.

## Deployment

- [**deployment/PREVIEW_DEPLOY.md**](./deployment/PREVIEW_DEPLOY.md) — preview-environment deploys.
- [**deployment/RELEASING_CORE.md**](./deployment/RELEASING_CORE.md) — publishing `@appstrate/core` to npm, and the consumer lockstep gate that guards it.

For production self-hosting, see [`../examples/self-hosting/README.md`](../examples/self-hosting/README.md)
and [`../examples/self-hosting/AUTH_MODES.md`](../examples/self-hosting/AUTH_MODES.md).

## Plans

Open follow-ups kept only while they still carry knowledge nothing else does. A
plan whose every item has landed is deleted, not archived.

- [**plans/post-pi-unification-cleanup.md**](./plans/post-pi-unification-cleanup.md) — follow-ups to #1173. Four of five landed; kept for item 3, which holds the measurements behind the `public-origin` coverage flag's phantom misses and the refutation of the obvious remedy.

## Elsewhere in the repo

| Topic                            | Where                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Security policy and architecture | [`../SECURITY.md`](../SECURITY.md)                                              |
| Module authoring                 | [`../apps/api/src/modules/README.md`](../apps/api/src/modules/README.md)        |
| Sidecar implementation           | [`../runtime-pi/sidecar/README.md`](../runtime-pi/sidecar/README.md)            |
| AFPS wire specification          | [appstrate/afps-spec](https://github.com/appstrate/afps-spec/blob/main/spec.md) |
| Contributing                     | [`../CONTRIBUTING.md`](../CONTRIBUTING.md)                                      |
