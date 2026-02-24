---
name: appstrate-api-guide
description: Comprehensive guide for autonomously operating the Appstrate platform via its REST API. Covers authentication, provider configuration, flow CRUD, skill and extension management, execution lifecycle, scheduling, and monitoring.
---

# Appstrate API Guide

Use this skill whenever you need to interact with the Appstrate platform programmatically. This covers the full API surface: authentication, provider setup, flow management, execution, scheduling, and monitoring.

## Agent Autonomy Principles

**You are an autonomous agent. Gather information from the API before asking the user anything.**

### Discover First, Ask Last

Before performing any action or asking any question, call the relevant GET endpoints to understand the current state:

1. **Need to know what flows exist?** → Call `GET /api/flows` — don't ask the user
2. **Need to know what providers are configured?** → Call `GET /api/providers` — don't ask the user
3. **Need to know what services are connected?** → Call `GET /auth/integrations` — don't ask the user
4. **Need to know what skills/extensions are available?** → Call `GET /api/library/skills` and `GET /api/library/extensions` — don't ask the user
5. **Need to know the flow's requirements?** → Call `GET /api/flows/{flowId}` — don't ask the user
6. **Need to know if config is set?** → The flow detail response includes current `config` values — don't ask the user

### Only Ask the User When You Must

The user should only be asked for things that **cannot be discovered via the API**:

- **API key**: The agent cannot create one programmatically without prior authentication. The user must create it in the web UI and provide it.
- **OAuth browser flow**: The user must open a URL in their browser to authorize an OAuth2 connection. You can generate the URL via the API, but the user must visit it.
- **Secrets and credentials**: API keys for external services (e.g., Brevo API key) are sensitive — the user must provide them.
- **Business decisions**: Which flow to create, what the prompt should say, what service to use — these require human judgment.

### Standard Discovery Sequence

When starting any task involving Appstrate, run this sequence to build your understanding:

```
1. GET /api/flows                    → What flows exist? What's their status?
2. GET /api/providers                → What providers are configured?
3. GET /auth/integrations            → What services are connected/disconnected?
4. GET /api/library/skills           → What skills are available?
5. GET /api/library/extensions       → What extensions are available?
```

You do NOT need to run all 5 every time — pick the ones relevant to your task. But **always gather context before acting**.

---

## Live API Documentation

The complete, up-to-date API documentation is available directly from any Appstrate instance:

- **OpenAPI 3.1 spec (JSON)**: `GET /api/openapi.json` — machine-readable spec you can fetch and parse to discover all endpoints, schemas, and parameters.
- **Swagger UI (interactive)**: `GET /api/docs` — human-readable interactive documentation with "Try it out" functionality.

Both endpoints are **public** (no authentication required). If you need to check the exact schema of a request or response, or discover endpoints not covered in this skill, fetch the OpenAPI spec:

```
curl {BASE_URL}/api/openapi.json
```

This is the authoritative source of truth for the API surface. Use it whenever you are unsure about a parameter, field type, or endpoint path.

---

## Skill Files — Read the Right File for Your Task

This skill is organized into focused reference files. **Read the file relevant to your current task** from this skill directory (`.pi/skills/appstrate-api-guide/`):

| File | When to Read |
|------|-------------|
| **`AUTH.md`** | You need to authenticate, validate an API key, connect a service, or manage OAuth/API-key connections |
| **`PROVIDERS.md`** | You need to create, configure, or research an external service provider (OAuth2, API key, custom auth) |
| **`FLOWS.md`** | You need to create, update, delete, import, or configure a flow. Also covers the manifest format and JSON schema rules |
| **`LIBRARY.md`** | You need to create, list, or manage skills and extensions in the library |
| **`EXECUTION.md`** | You need to run a flow, monitor execution, stream logs, cancel, or set up automation (webhooks, triggers) |
| **`SCHEDULING.md`** | You need to create, update, or manage cron schedules for recurring flow runs |
| **`ADMIN.md`** | You need to manage organizations, members, API keys, or share tokens |
| **`REFERENCE.md`** | You encounter an error, need the error code table, common workflows, health check, or rate limits |
| **`TROUBLESHOOTING.md`** | An API call failed or an execution doesn't behave as expected — step-by-step diagnostics |
| **`manifest-template.json`** | You need to create a new flow manifest — copy and adapt this template instead of writing from scratch |

**How to use**: Read the relevant file(s) with your filesystem tools before making API calls. For example, before creating a provider, read `PROVIDERS.md`. Before running a flow, read `EXECUTION.md`.

---

## Tips for Agents

1. **Always discover before acting**: Call GET endpoints to understand the current state before creating, updating, or asking the user anything.
2. **Validate your API key immediately**: The first thing you do with a new key is `GET /api/flows` to verify it works.
3. **Check flow detail before running**: `GET /api/flows/{flowId}` tells you everything — services, config, input schema, running executions.
4. **Resolve blockers autonomously**: If a service is disconnected, figure out the `authMode` and initiate the connection. Only ask the user for secrets.
5. **Poll with backoff**: When waiting for execution completion, use 2-5 second intervals.
6. **Use pagination for logs**: Pass `?after={lastId}` to `GET /api/executions/{executionId}/logs` for incremental log retrieval.
7. **Handle optimistic locking**: Always fetch the current `updatedAt` before updating a flow.
8. **Check provider authorized URIs**: If the agent needs to call a URL, verify the provider's `authorizedUris` includes it via `GET /api/providers`.
9. **Use state for continuity**: If your flow needs to remember data between runs, include a `state` field in the output.
10. **Never guess, always verify**: If you're unsure whether something exists or is configured, call the API. It's free.
