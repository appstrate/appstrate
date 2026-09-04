// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI info, servers, security defaults, and tags.
 */
export const openApiInfo = {
  openapi: "3.1.0",
  info: {
    title: "Appstrate API",
    version: "1.0.0",
    description:
      'API for Appstrate — an open-source platform for running autonomous AI agents in sandboxed Docker containers. Manage agents, runs, schedules, providers, API keys, and more.\n\n## Common Response Headers\n\nAll API responses include a `Request-Id` header (`req_` prefix) for tracing. All authenticated responses additionally include an `Appstrate-Version` header with the resolved API version (format: `YYYY-MM-DD`). Rate-limited endpoints return `RateLimit` and `RateLimit-Policy` headers on every response (not just 429).\n\n## Idempotency\n\n`Idempotency-Key` is honoured **only** on the operations that declare it as a parameter. Sending it anywhere else is refused, not ignored: any other request with an unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`, …) that carries the header is rejected before it reaches the handler with `400` `application/problem+json`, `code: "idempotency_not_supported"`. Safe methods (`GET`, `HEAD`, `OPTIONS`) ignore the header — replaying them is already free of effect (RFC 9110 §9.2.1), so there is no guarantee to correct.\n\nThis response is produced by a request-level middleware rather than by any operation, so it is documented here instead of on each of the ~130 operations that can emit it. A client that never sends `Idempotency-Key` outside the operations declaring it will never see it. Do not stamp the header onto every outbound request: on this API that turns a working call into a `400`.\n\nOn the operations that do honour it, the key is stored for 24h scoped to the organization and space: a repeat with the same key and the same body replays the original response with `Idempotent-Replayed: true`; the same key with a different body is `422` `idempotency_conflict`; a concurrent in-flight duplicate is `409` `idempotency_in_progress`.\n\n**Not covered:** `/api/auth/*` (Better Auth) terminates the request chain before this middleware runs. Those endpoints — sign-up/sign-in/sign-out, the device flow, `cli/token`, `cli/revoke`, `organization/*` — neither honour nor refuse the header; they ignore it.',
    contact: {
      name: "Appstrate",
      url: "https://appstrate.dev",
      email: "contact@appstrate.dev",
    },
    license: {
      name: "Apache-2.0",
      url: "https://www.apache.org/licenses/LICENSE-2.0",
    },
  },
  servers: [
    {
      url: "/",
      description: "Current server",
    },
  ],
  security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
  tags: [
    { name: "Auth", description: "Authentication (Better Auth)" },
    { name: "Agents", description: "Agent management" },
    { name: "Runs", description: "Agent runs and logs" },
    { name: "Schedules", description: "Cron scheduling" },
    { name: "API Keys", description: "API key management for programmatic access" },
    { name: "Packages", description: "Organization skills, agents, and integration packages" },
    {
      name: "Library",
      description: "Consolidated package catalog across an organization's spaces (UI-oriented).",
    },
    { name: "Notifications", description: "Run notification management" },
    { name: "Organizations", description: "Organization and member management" },
    { name: "Profile", description: "User profile management" },
    { name: "Realtime", description: "Server-Sent Events (SSE) for real-time updates" },
    { name: "Invitations", description: "Organization invitation acceptance" },
    { name: "Welcome", description: "Post-invite profile setup" },
    { name: "Health", description: "Health check" },
    { name: "Internal", description: "Container-to-host internal routes" },
    { name: "Models", description: "LLM model configuration" },
    { name: "Proxies", description: "Org-level HTTP proxy configuration" },
    { name: "Meta", description: "API documentation and specification" },
    { name: "Spaces", description: "Space management for headless API" },
    {
      name: "Roles",
      description: "Space-role presets and organization-defined custom role bundles",
    },
    { name: "Space Packages", description: "Manage packages installed in a space" },
    { name: "End Users", description: "End-user management for headless API" },
    { name: "Uploads", description: "Direct-upload protocol for agent input files" },
    { name: "Files", description: "Durable file store — inputs and agent outputs" },
    {
      name: "Credential Proxy",
      description: "Server-side credential injection for external runners (CLI, GitHub Action)",
    },
    {
      name: "LLM Proxy",
      description: "Server-side LLM model injection — OpenAI + Anthropic protocol families",
    },
    {
      name: "Admin",
      description: "Platform-admin operator surfaces (storage-deletion outbox, dead letters)",
    },
  ],
} as const;
