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
      "API for Appstrate — an open-source platform for running autonomous AI agents in sandboxed Docker containers. Manage agents, runs, schedules, providers, API keys, and more.\n\n## Common Response Headers\n\nAll API responses include a `Request-Id` header (`req_` prefix) for tracing. All authenticated responses additionally include an `Appstrate-Version` header with the resolved API version (format: `YYYY-MM-DD`). Rate-limited endpoints return `RateLimit` and `RateLimit-Policy` headers on every response (not just 429).",
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
      description:
        "Consolidated package catalog across an organization's applications (UI-oriented).",
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
    { name: "Applications", description: "Application management for headless API" },
    { name: "Application Packages", description: "Manage packages installed in an application" },
    { name: "End Users", description: "End-user management for headless API" },
    { name: "Uploads", description: "Direct-upload protocol for agent input files" },
    { name: "Documents", description: "Durable document store — inputs and agent outputs" },
    {
      name: "Credential Proxy",
      description: "Server-side credential injection for external runners (CLI, GitHub Action)",
    },
    {
      name: "LLM Proxy",
      description: "Server-side LLM model injection — OpenAI + Anthropic protocol families",
    },
  ],
} as const;
