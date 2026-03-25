# Appstrate Security Architecture

Appstrate executes AI agent code inside ephemeral Docker containers with full access to bash, curl, and arbitrary tools. Users connect sensitive services — Gmail, ClickUp, Brevo, Google Calendar — via OAuth or API keys. The central security challenge is: **how do you give an AI agent the ability to call authenticated APIs without ever exposing credentials to the agent itself?**

This document describes Appstrate's defense-in-depth approach, the threat model it addresses, and how each layer maps to industry standards.

---

## Table of Contents

- [Threat Model](#threat-model)
- [Architecture Overview](#architecture-overview)
- [Layer 1 — Network Isolation](#layer-1--network-isolation)
- [Layer 2 — Credential Brokering via Sidecar Proxy](#layer-2--credential-brokering-via-sidecar-proxy)
- [Layer 3 — URL Authorization](#layer-3--url-authorization)
- [Layer 4 — Container Hardening](#layer-4--container-hardening)
- [Layer 5 — Platform Authentication](#layer-5--platform-authentication)
- [Layer 6 — Data Isolation (Application-Level Security)](#layer-6--data-isolation-application-level-security)
- [Layer 7 — Input Validation](#layer-7--input-validation)
- [Layer 8 — Operational Safety](#layer-8--operational-safety)
- [Industry Standards Compliance](#industry-standards-compliance)
- [Academic Research Alignment](#academic-research-alignment)
- [References](#references)

---

## Threat Model

Appstrate assumes the AI agent is **untrusted**. This is not a theoretical concern — it is the defining constraint of the system. The agent executes arbitrary code from an LLM, which can be influenced by:

| Threat                              | Vector                                                                        | Impact                                           |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| **Prompt injection**                | Malicious content in emails, tickets, or API responses processed by the agent | Agent executes attacker-controlled instructions  |
| **Credential exfiltration**         | Agent reads environment variables or files containing OAuth tokens            | Full account takeover of connected services      |
| **Lateral movement**                | Agent reaches the platform API or other containers on the network             | Access to other users' data, platform compromise |
| **Unauthorized API calls**          | Agent calls APIs beyond its declared scope                                    | Data destruction, spam, financial loss           |
| **Data leakage via error messages** | Credentials appear in error responses, logs, or stack traces                  | Token exposure through side channels             |

The OWASP Top 10 for LLM Applications (2025) classifies these under **LLM01 (Prompt Injection)**, **LLM02 (Sensitive Information Disclosure)**, and **LLM06 (Excessive Agency)**.

**Design principle:** Every defense assumes the agent is actively hostile. No single layer is sufficient — each layer independently limits blast radius.

---

## Architecture Overview

Each flow execution creates an isolated, ephemeral environment with two containers and a dedicated network:

```
                    Platform API (host)
                         |
                    [host.docker.internal]
                         |
    ╔════════════════════╧════════════════════════╗
    ║  Docker Network: appstrate-exec-{execId}    ║
    ║  (custom bridge, per-execution, ephemeral)  ║
    ║                                             ║
    ║  ┌───────────────────────┐                  ║
    ║  │   Sidecar Container   │                  ║
    ║  │   alias: "sidecar"    │                  ║
    ║  │                       │                  ║
    ║  │ - EXECUTION_TOKEN  ✓  │ ← host access    ║
    ║  │ - PLATFORM_API_URL ✓  │ ← ExtraHosts     ║
    ║  │ - Fetches credentials │                  ║
    ║  │ - Validates URLs      │                  ║
    ║  │ - Substitutes vars    │                  ║
    ║  │ - Returns response    │                  ║
    ║  └──────────▲────────────┘                  ║
    ║             │                               ║
    ║  ┌──────────┴────────────┐                  ║
    ║  │   Agent Container     │                  ║
    ║  │   alias: "agent"      │                  ║
    ║  │                       │                  ║
    ║  │ - NO EXECUTION_TOKEN  │ ← no host access ║
    ║  │ - NO PLATFORM_API_URL │ ← no ExtraHosts  ║
    ║  │ - NO credentials      │                  ║
    ║  │ - SIDECAR_URL only    │                  ║
    ║  │ - Runs LLM agent code │                  ║
    ║  └───────────────────────┘                  ║
    ╚═════════════════════════════════════════════╝
```

**What the agent can reach:** The sidecar container, via `http://sidecar:8080`. Nothing else.

**What the agent cannot reach:** The platform API, the host machine, other execution networks, the internet (except through the sidecar proxy), environment variables containing tokens.

---

## Layer 1 — Network Isolation

**Files:** `apps/api/src/services/adapters/pi.ts`, `apps/api/src/services/docker.ts`

Each execution creates a dedicated Docker bridge network (`appstrate-exec-{executionId}`). Two containers are placed on this network:

- **Sidecar** — created with `extraHosts: ["host.docker.internal:host-gateway"]`, enabling it to reach the platform API on the host.
- **Agent** — created with **no** `extraHosts` and **no** default bridge connection. The only DNS name it can resolve is `sidecar`.

```typescript
// Agent container — custom network ONLY, no host access
const containerId = await createContainer(executionId, containerEnv, {
  image: PI_RUNTIME_IMAGE,
  adapterName: "pi",
  networkId, // isolated per-execution network
  networkAlias: "agent", // no extraHosts = no route to host
});
```

**Why this matters:** Even if the agent discovers internal URLs or tokens via prompt injection, it has **no network route** to reach them. DNS resolution for `host.docker.internal` fails. Direct IP connections to the host are blocked by the bridge network configuration.

**Standard:** This implements the network segmentation controls described in **NIST SP 800-190** (Application Container Security Guide) Section 4.4, and the micro-segmentation principle from **NIST SP 800-207** (Zero Trust Architecture).

---

## Layer 2 — Credential Brokering via Sidecar Proxy

**Files:** `runtime-pi/sidecar/server.ts`, `apps/api/src/routes/internal.ts`

Credentials are **never** passed to the agent container — not as environment variables, not as files, not as API responses. Instead, the agent makes standard HTTP requests through the sidecar proxy, which injects credentials transparently.

### How the agent makes authenticated API calls

The agent sends a regular HTTP request to the sidecar with two routing headers:

```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/messages" \
  -H "Authorization: Bearer {{token}}"
```

The sidecar:

1. **Fetches credentials** from the platform API (`GET /internal/credentials/gmail`) using its `EXECUTION_TOKEN`
2. **Substitutes** `{{token}}` with the real OAuth access token in headers and URL
3. **Validates** the resolved URL against `authorizedUris` (see [Layer 3](#layer-3--url-authorization))
4. **Forwards** the request to the target API with real credentials
5. **Returns** only the response body (status + text) — no credentials in the response

### What the agent sees vs. what is transmitted

| Component   | Agent sees                         | Wire (to target API)                   |
| ----------- | ---------------------------------- | -------------------------------------- |
| URL         | `https://gmail.googleapis.com/...` | `https://gmail.googleapis.com/...`     |
| Auth header | `Bearer {{token}}`                 | `Bearer ya29.a0AfH6SM...` (real token) |
| Response    | Raw upstream body (status code forwarded) | —                               |
| Credentials | Never                              | Substituted by sidecar                 |

### Credential access is scoped and audited

The platform API (`/internal/credentials/:providerId`) enforces additional controls:

- **Execution must be running** — tokens for completed/failed executions are rejected (`internal.ts`)
- **Provider must be declared** — the requested `providerId` must appear as a key in the flow's `manifest.requires.providers` object. An agent cannot request credentials for providers it hasn't declared.
- **Access is logged** — every credential fetch is recorded with execution ID, provider ID, and flow ID

### Why not pass credentials as environment variables?

Environment variables are the most common credential delivery mechanism in containerized systems. Appstrate intentionally does **not** use them because:

1. **Prompt injection can read env vars** — `env`, `printenv`, `/proc/self/environ` are trivially accessible to any agent with shell access
2. **LLM context contains env vars** — many agent frameworks log or include environment context in the LLM conversation
3. **Credentials persist in container metadata** — `docker inspect` reveals all env vars even after the container exits

The sidecar pattern ensures credentials exist only in the sidecar's memory, for the duration of a single HTTP request.

**Standard:** This architecture follows the **sidecar proxy pattern** as defined by Microsoft Azure Architecture Patterns and operationalized by the CNCF ecosystem (Envoy, Istio, SPIFFE/SPIRE). The credential injection model mirrors Envoy's Secret Discovery Service (SDS) — credentials are delivered to the proxy infrastructure, never to the application. OWASP's Kubernetes Top 10 (K08:2022) explicitly documents this pattern: _"a sidecar container authenticates with the secrets manager, retrieves the secret"_ without exposing it to the application container.

---

## Layer 3 — URL Authorization

**Files:** `runtime-pi/sidecar/server.ts`, `apps/api/src/services/adapters/provider-urls.ts`

Every outbound request through the sidecar is validated against an allowlist of authorized URL patterns. This prevents an agent from using valid credentials to call unintended endpoints.

### How it works

Each provider declares `authorized_uris` — either explicitly in the flow manifest or derived from provider defaults:

```json
{
  "id": "gmail",
  "provider": "gmail",
  "authorized_uris": ["https://gmail.googleapis.com/*", "https://www.googleapis.com/upload/*"]
}
```

The sidecar validates the fully-resolved URL (after `{{variable}}` substitution) against these patterns **before** making the request:

```typescript
function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
  });
}
```

**Unauthorized requests return 403:**

```json
{
  "error": "URL not authorized for provider \"gmail\". Allowed: https://gmail.googleapis.com/*, https://www.googleapis.com/upload/*"
}
```

### Defense against credential misuse

Without URL authorization, an agent with Gmail OAuth credentials could call any Google API endpoint — Drive, Calendar, Admin SDK — using the same token. The `authorized_uris` constraint scopes each credential to its intended API surface.

**Standard:** This implements the principle of **least privilege** as defined in **NIST SP 800-53 Rev 5** control **AC-6** (Least Privilege). The URL allowlist acts as a Policy Enforcement Point in the **NIST SP 800-207A** Zero Trust model for cloud-native applications.

---

## Layer 4 — Container Hardening

**Files:** `runtime-pi/Dockerfile`, `runtime-pi/sidecar/Dockerfile`, `apps/api/src/services/docker.ts`

### Non-root execution

Both containers run as non-root users:

```dockerfile
# Agent container (runtime-pi/Dockerfile)
RUN useradd -m -s /bin/bash pi
USER pi

# Sidecar container (runtime-pi/sidecar/Dockerfile)
USER bun
```

### Resource limits

Docker resource constraints prevent resource exhaustion attacks:

| Container | Memory | CPU      |
| --------- | ------ | -------- |
| Agent     | 1 GB   | 2 vCPUs  |
| Sidecar   | 256 MB | 0.5 vCPU |

```typescript
// docker.ts — enforced at container creation
const DEFAULT_MEMORY = 1024 * 1024 * 1024; // 1 GB
const DEFAULT_NANO_CPUS = 2_000_000_000; // 2 vCPUs
```

### Ephemeral containers

Containers are created, executed, and destroyed per execution. No persistent state survives between runs. The `finally` block in `pi.ts` ensures cleanup even on errors:

```typescript
finally {
  if (sidecarContainerId) {
    await stopContainer(sidecarContainerId).catch(log);
    await removeContainer(sidecarContainerId).catch(log);
  }
  if (networkId) {
    await removeNetwork(networkId).catch(log);
  }
}
```

### Container labeling

All managed containers are labeled for auditability:

```typescript
Labels: {
  "appstrate.execution": executionId,
  "appstrate.adapter": adapterName,
  "appstrate.managed": "true",
}
```

**Standard:** These controls align with the **CIS Docker Benchmark v1.8.0** recommendations: non-root users (Section 4.1), resource limits (Section 5.10-5.11), container labeling (Section 5.13), and minimal container lifetime.

---

## Layer 5 — Platform Authentication

### User authentication (Cookie Sessions)

All API endpoints under `/api/*` and `/auth/*` require a valid Better Auth session cookie:

```typescript
// index.ts — global middleware
app.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "UNAUTHORIZED", message: "Invalid or missing session" }, 401);
  }
  c.set("user", { id: session.user.id, email: session.user.email });
  return next();
});
```

Sessions are managed by Better Auth (email/password + optional Google social login, cookie-based sessions). Account linking uses trusted providers (Google) with verified emails to prevent pre-account takeover. Email verification is opt-in (requires SMTP configuration). The session cookie is set on login/signup and verified server-side on every request via `auth.api.getSession()`.

### Organization context verification

Every authenticated request must include an `X-Org-Id` header. The middleware verifies the user is a member of the specified organization via Drizzle:

```typescript
// org-context.ts
const membership = await db
  .select({ role: organizationMembers.role })
  .from(organizationMembers)
  .where(
    and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, user.id)),
  )
  .limit(1);
if (!membership[0]) return c.json({ error: "FORBIDDEN" }, 403);
```

### Execution tokens (container-to-host)

Internal endpoints (`/internal/*`) use the execution ID as a bearer token. This token is:

- **Time-bound** — only valid while the execution status is `running`
- **Scope-limited** — only grants access to credentials for services declared in the flow manifest
- **Single-use per execution** — tied to a specific execution record in the database

```typescript
// internal.ts — credential endpoint
const rows = await db
  .select({ packageId: executions.packageId, status: executions.status, orgId: executions.orgId })
  .from(executions)
  .where(eq(executions.id, executionId))
  .limit(1);

if (!rows[0] || rows[0].status !== "running") {
  return c.json({ error: "Invalid or expired execution token" }, 401);
}
```

### Admin guards

Privileged operations (flow import, configuration, deletion) require admin role within the organization:

```typescript
// guards.ts
export function requireAdmin() {
  return async (c: Context, next: Next) => {
    const orgRole = c.get("orgRole");
    if (orgRole !== "admin" && orgRole !== "owner") {
      return c.json({ error: "FORBIDDEN" }, 403);
    }
    await next();
  };
}
```

### Orphaned execution recovery

On platform startup, any executions left in `pending` or `running` state from a previous crash are marked as `failed`. This prevents stale execution tokens from remaining valid:

```typescript
// index.ts — startup
await markOrphanExecutionsFailed();
```

**Standard:** This multi-layer authentication model implements the access control architecture described in **NIST SP 800-207** (Zero Trust Architecture): per-request verification, no implicit trust, and session-scoped credentials with automatic expiration.

---

## Layer 6 — Data Isolation (Application-Level Security)

**Files:** `apps/api/src/middleware/org-context.ts`, `apps/api/src/services/state.ts`, all route handlers

All data access is scoped by organization at the application level. Every Drizzle query includes an `orgId` filter via `where` clauses, enforced by the org-context middleware which validates organization membership on every request.

| Table                  | SELECT          | INSERT                | UPDATE                | DELETE                |
| ---------------------- | --------------- | --------------------- | --------------------- | --------------------- |
| `executions`           | Org members     | Own user + org member | —                     | —                     |
| `execution_logs`       | Org members     | Org members           | —                     | —                     |
| `flow_configs`         | Org members     | Org admins            | Org admins            | Org admins            |
| `flows`                | Org members     | Org admins            | Org admins            | Org admins            |
| `flow_schedules`       | Org members     | Own user + org member | Own user + org member | Own user + org member |
| `user_provider_connections` | Own user + org  | Own user + org member | Own user + org member | Own user + org member |
| `share_links`          | Org members     | Org members           | Org members           | —                     |

Application-level isolation uses the org-context middleware and Drizzle `where` clauses:

```typescript
// org-context.ts — verify membership on every request
const membership = await db
  .select({ role: organizationMembers.role })
  .from(organizationMembers)
  .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, user.id)))
  .limit(1);
if (!membership[0]) return c.json({ error: "FORBIDDEN" }, 403);
c.set("orgId", orgId);
c.set("orgRole", membership[0].role);

// Every query filters by orgId — example from state.ts
const rows = await db
  .select()
  .from(executions)
  .where(and(eq(executions.packageId, packageId), eq(executions.orgId, orgId)));
```

**Standard:** Application-level org-scoped queries implement access control satisfying **NIST SP 800-53** controls **AC-3** (Access Enforcement) and **AC-4** (Information Flow Enforcement).

---

## Layer 7 — Input Validation

**Files:** `apps/api/src/services/schema.ts`, `apps/api/src/services/flow-import.ts`

All external inputs are validated using Zod schemas before processing:

| Input              | Validation                                                | Location                         |
| ------------------ | --------------------------------------------------------- | -------------------------------- |
| Flow manifests     | Zod schema with slug regex, typed enums, required fields  | `schema.ts:validateManifest()`   |
| Flow configuration | AJV against manifest config schema                        | `schema.ts:validateConfig()`     |
| Execution input    | AJV against manifest input schema                         | `schema.ts:validateInput()`      |
| File uploads       | Extension allowlist, size limit, count limit              | `schema.ts:validateFileInputs()` |
| Agent output       | Native LLM schema enforcement + AJV post-validation       | `schema.ts:validateOutput()`     |
| ZIP imports        | 10 MB size limit, manifest validation, content validation | `flow-import.ts`                 |
| Flow IDs           | Slug regex at DB level and Zod level                      | `schema.ts`, `001_initial.sql`   |

**Output validation:** When a flow defines `output.schema`, the schema is injected into the agent container (`OUTPUT_SCHEMA` env var) so the LLM tool definition includes the exact JSON Schema for constrained decoding. Post-execution, AJV validates the merged result against the schema. On mismatch, a warning is logged. This dual-layer approach (LLM-level + platform-level) prevents malformed output from being persisted.

**Standard:** Input validation addresses **OWASP API Security Top 10** risks **API8:2023** (Security Misconfiguration) and aligns with **OWASP Top 10 for LLM Applications** **LLM05:2025** (Improper Output Handling).

---

## Layer 8 — Operational Safety

### Rate limiting

Token bucket rate limiting prevents abuse:

| Endpoint                  | Limit     | Scope    |
| ------------------------- | --------- | -------- |
| `POST /api/flows/:id/run` | 20/minute | Per user |
| `POST /api/flows/import`  | 10/minute | Per user |
| `POST /api/flows`         | 10/minute | Per user |

### Execution timeout

Every execution has a configurable timeout (default defined in flow manifest). On timeout, both the agent and sidecar containers are forcibly stopped:

```typescript
const timeoutHandle = setTimeout(() => {
  timedOut = true;
  stopContainer(containerId).catch(() => {});
  for (const id of options.stopOnTimeout ?? []) {
    stopContainer(id).catch(() => {});
  }
}, timeoutMs);
```

### Graceful shutdown

On SIGTERM/SIGINT, the platform:

1. Stops accepting new execution requests (503)
2. Stops the cron scheduler
3. Waits up to 30 seconds for in-flight executions to complete
4. Forces exit if timeout is exceeded

### Execution cancellation

Running executions can be cancelled via API. The cancel handler verifies organization ownership before aborting:

```typescript
if (execution.org_id !== orgId) {
  return c.json({ error: "FORBIDDEN" }, 403);
}
abortExecution(executionId);
await stopContainer(containerId);
```

### Structured logging

All backend operations use structured JSON logging (`lib/logger.ts`). Credential access events are logged with execution ID, provider ID, and flow ID — **never with credential values**.

### Response size limits

The sidecar truncates API responses at 50 KB to prevent memory exhaustion from large responses:

```typescript
const MAX_RESPONSE_SIZE = 50_000;
const truncated = responseText.length > MAX_RESPONSE_SIZE;
```

### Error message sanitization

Error messages from the sidecar use the **original** URL template (with `{{variable}}` placeholders), not the resolved URL containing real credential values:

```typescript
// Safe: returns "Request to https://api.example.com?key={{api_key}} failed"
// NOT: "Request to https://api.example.com?key=sk-live-abc123... failed"
error: `Request to ${targetUrl} failed: ${err.message}`,
```

---

## Industry Standards Compliance

### NIST SP 800-190 — Application Container Security Guide

| Recommendation             | Appstrate Implementation                                    |
| -------------------------- | ----------------------------------------------------------- |
| Run containers as non-root | `USER pi` / `USER bun` in Dockerfiles                       |
| Set resource limits        | Memory and CPU limits on all containers                     |
| Segment container networks | Per-execution bridge network with no host access for agents |
| Use immutable containers   | Ephemeral containers destroyed after each execution         |
| Minimize container images  | `bun:1-slim` base, production-only dependencies             |

### NIST SP 800-207 — Zero Trust Architecture

| Tenet                                                 | Appstrate Implementation                                      |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| All data sources and computing services are resources | Each service connection is a discrete, authenticated resource |
| All communication is secured regardless of location   | Execution tokens validated per-request, even on internal APIs |
| Access is granted on a per-session basis              | Execution tokens expire when execution completes              |
| Access is determined by dynamic policy                | Service allowlists checked at runtime via `authorizedUris`    |
| Enterprise monitors and measures integrity            | Structured logging of all credential access events            |

### NIST SP 800-207A — Zero Trust for Cloud-Native Applications

| Recommendation                             | Appstrate Implementation                            |
| ------------------------------------------ | --------------------------------------------------- |
| Use sidecar proxies for policy enforcement | Credential sidecar proxy with URL authorization     |
| Short-lived, scoped credentials            | Execution tokens valid only during `running` state  |
| Identity-tier policies                     | Service access scoped to flow manifest declarations |
| Network-tier policies                      | Per-execution isolated bridge networks              |

### NIST SP 800-53 Rev 5 — Security Controls

| Control                                     | Implementation                                                     |
| ------------------------------------------- | ------------------------------------------------------------------ |
| **AC-3** Access Enforcement                 | Application-level org-scoped queries, cookie session auth, org membership verification |
| **AC-4** Information Flow Enforcement       | Network isolation, sidecar proxy, credential brokering             |
| **AC-6** Least Privilege                    | Agent has zero credentials, scoped URL authorization, admin guards |
| **AU-3** Content of Audit Records           | Structured JSON logging with execution context                     |
| **SC-7** Boundary Protection                | Docker bridge network, no host access for agents                   |
| **SC-28** Protection of Information at Rest | Credentials encrypted via AES-256-GCM in PostgreSQL (application-level isolation) |

### CIS Docker Benchmark v1.8.0

| Section                 | Status    | Notes                                                           |
| ----------------------- | --------- | --------------------------------------------------------------- |
| 4.1 Non-root user       | Compliant | `USER pi` / `USER bun`                                          |
| 5.10 Memory limits      | Compliant | 1 GB agent, 256 MB sidecar                                      |
| 5.11 CPU limits         | Compliant | 2 vCPU agent, 0.5 vCPU sidecar                                  |
| 5.13 Container labeling | Compliant | `appstrate.execution`, `appstrate.adapter`, `appstrate.managed` |
| 5.15 Host network mode  | Compliant | Custom bridge networks, no `--network host`                     |

### OWASP Top 10 for LLM Applications (2025)

| Risk                                         | Mitigation                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **LLM01 — Prompt Injection**                 | Credentials never in agent context. Even under full prompt injection, the agent cannot exfiltrate secrets it does not possess. |
| **LLM02 — Sensitive Information Disclosure** | No credentials in environment variables, no credentials in error messages, response truncation.                                |
| **LLM05 — Improper Output Handling**         | Native LLM schema enforcement via tool parameter injection + AJV post-validation against output schema.                        |
| **LLM06 — Excessive Agency**                 | URL authorization limits API surface. Service allowlisting limits credential scope. Agent cannot request undeclared services.  |

### OWASP API Security Top 10 (2023)

| Risk                                           | Mitigation                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| **API1 — BOLA**                                | Execution tokens scoped to single execution. Org-scoped queries enforce data isolation. |
| **API2 — Broken Authentication**               | Multi-layer auth: cookie sessions + org membership + admin guards + execution tokens.   |
| **API5 — Broken Function Level Authorization** | Admin guards on privileged operations. Org-scoped queries at application level.          |
| **API8 — Security Misconfiguration**           | `authorizedUris` URL restriction. Input validation on all external boundaries.      |

---

## Academic Research Alignment

Recent research (2024-2025) on AI agent security validates Appstrate's architecture:

### "Security of AI Agents" (He, Wang et al., 2024)

> _"With appropriate sandbox configurations, agents successfully defended against all LLM-generated attacks."_

This paper demonstrates that alignment training alone is insufficient to secure AI agents, and that **sandbox-based access control on local resources is necessary**. Appstrate's network-isolated containers with zero credential access implement exactly this recommendation.

**Reference:** arXiv:2406.08689

### "Securing AI Agent Execution" (Buhler, Biagiola et al., 2025)

Introduces **AgentBound**, the first access control framework for MCP servers. Combines a declarative policy mechanism (AgentManifest) with a sandbox enforcement engine (AgentBox). Appstrate's flow manifest (`requires.providers` object with `authorized_uris` in provider definitions) is architecturally analogous to AgentManifest — a declarative specification of what the agent is allowed to access.

**Reference:** arXiv:2510.21236

### "Fault-Tolerant Sandboxing for AI Coding Agents" (2025)

Presents a policy-based interception layer for autonomous coding agents, achieving **100% interception rate for high-risk commands** with only 14.5% performance overhead. Appstrate's sidecar proxy functions as a similar interception layer — all outbound API calls must pass through it, enabling policy enforcement (URL authorization) and credential injection.

**Reference:** arXiv:2512.12806

### "CELLMATE: Sandboxing Browser AI Agents" (Meng et al., UC San Diego, 2024)

Documents real exploits against production AI agents (Perplexity's Comet, OpenAI's Operator) involving **credential and session leakage**. Identifies the "lethal trifecta" of _ambient privilege + untrusted input + tool access_. Appstrate eliminates ambient privilege by ensuring credentials never enter the agent's address space.

**Reference:** arXiv:2512.12594

### "Agentic AI Security: Threats, Defenses, Evaluation" (2025)

Comprehensive survey covering execution isolation architectures and real-world exploits (EchoLeak CVE-2025-32711 against Microsoft Copilot, credential stuffing via OpenAI's Operator). Concludes that **"airtight sandboxing is indispensable"** for agentic AI systems. References the necessity of defense-in-depth with multiple isolation layers.

**Reference:** arXiv:2510.23883

### "From Prompt Injections to Protocol Exploits" (ScienceDirect, 2025)

Unified end-to-end threat model cataloging 30+ attack techniques including tool poisoning and MCP-specific exploits. Validates the need for credential isolation at the infrastructure level rather than relying on prompt-level defenses.

### "Design Patterns to Secure LLM Agents In Action" (ReverseC Labs, 2025)

Documents two patterns directly implemented by Appstrate:

1. **Action Sandboxing** — executing tools in containers with minimal permissions
2. **Permission Boundaries** — ensuring agent permissions never exceed the scope of the current task

---

## References

### Standards & Frameworks

| Document                                                    | Identifier                                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| NIST SP 800-53 Rev 5 — Security and Privacy Controls        | [csrc.nist.gov/pubs/sp/800/53/r5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)                            |
| NIST SP 800-190 — Application Container Security Guide      | [csrc.nist.gov/pubs/sp/800/190](https://csrc.nist.gov/pubs/sp/800/190/final)                                     |
| NIST SP 800-207 — Zero Trust Architecture                   | [csrc.nist.gov/pubs/sp/800/207](https://csrc.nist.gov/pubs/sp/800/207/final)                                     |
| NIST SP 800-207A — Zero Trust for Cloud-Native Applications | [csrc.nist.gov/pubs/sp/800/207/a](https://csrc.nist.gov/pubs/sp/800/207/a/final)                                 |
| CIS Docker Benchmark v1.8.0                                 | [cisecurity.org/benchmark/docker](https://www.cisecurity.org/benchmark/docker)                                   |
| OWASP Top 10 for LLM Applications 2025                      | [genai.owasp.org](https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/)                      |
| OWASP API Security Top 10 (2023)                            | [owasp.org/API-Security](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)                              |
| OWASP Secrets Management Cheat Sheet                        | [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) |
| OWASP Kubernetes Top 10 — K08 Secrets Management            | [owasp.org](https://owasp.org/www-project-kubernetes-top-ten/2022/en/src/K08-secrets-management)                 |

### Industry Projects

| Project                                                                      | Role in Appstrate's architecture                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Envoy Proxy](https://www.envoyproxy.io/) (CNCF Graduated)                   | Origin of the sidecar proxy pattern for credential injection                          |
| [Istio](https://istio.io/latest/docs/concepts/security/)                     | Service mesh demonstrating transparent mTLS via sidecar without application awareness |
| [SPIFFE/SPIRE](https://spiffe.io/) (CNCF)                                    | Workload identity standard; credential delivery via SDS API without env var exposure  |
| [Docker Bench for Security](https://github.com/docker/docker-bench-security) | Automated CIS Docker Benchmark compliance testing                                     |

### Academic Papers

| Paper                                                    | Year | Identifier                                                                           |
| -------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| Security of AI Agents (He, Wang et al.)                  | 2024 | [arXiv:2406.08689](https://arxiv.org/abs/2406.08689)                                 |
| Securing AI Agent Execution — AgentBound (Buhler et al.) | 2025 | [arXiv:2510.21236](https://arxiv.org/abs/2510.21236)                                 |
| Fault-Tolerant Sandboxing for AI Coding Agents           | 2025 | [arXiv:2512.12806](https://arxiv.org/abs/2512.12806)                                 |
| CELLMATE: Sandboxing Browser AI Agents (Meng et al.)     | 2024 | [arXiv:2512.12594](https://arxiv.org/abs/2512.12594)                                 |
| Agentic AI Security: Threats, Defenses, Evaluation       | 2025 | [arXiv:2510.23883](https://arxiv.org/abs/2510.23883)                                 |
| From Prompt Injections to Protocol Exploits              | 2025 | [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2405959525001997) |
