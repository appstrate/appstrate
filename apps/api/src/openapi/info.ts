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
      "API for Appstrate — an open-source platform for running autonomous AI agents in sandboxed Docker containers. Manage agents, runs, schedules, providers, API keys, and more.\n\n## Common Response Headers\n\nAll API responses include a `Request-Id` header (`req_` prefix) for tracing. All authenticated responses additionally include an `Appstrate-Version` header with the resolved API version (format: `YYYY-MM-DD`). Deprecated API versions include a `Sunset` header (RFC 8594). Rate-limited endpoints return `RateLimit` and `RateLimit-Policy` headers on every response (not just 429).",
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
    { name: "Providers", description: "Provider configuration (OAuth2, API key, etc.)" },
    { name: "API Keys", description: "API key management for programmatic access" },
    { name: "Packages", description: "Organization skills, tools, and package management" },
    { name: "Notifications", description: "Run notification management" },
    { name: "Organizations", description: "Organization and member management" },
    { name: "Profile", description: "User profile management" },
    { name: "Realtime", description: "Server-Sent Events (SSE) for real-time updates" },
    { name: "Connections", description: "Provider connections (OAuth, API key)" },
    { name: "Invitations", description: "Organization invitation magic links" },
    { name: "Welcome", description: "Post-invite profile setup" },
    { name: "Health", description: "Health check" },
    { name: "Internal", description: "Container-to-host internal routes" },
    { name: "Models", description: "LLM model configuration" },
    { name: "Connection Profiles", description: "Shared connection sets across agents" },
    { name: "App Profiles", description: "Application-scoped connection profiles" },
    { name: "Proxies", description: "Org-level HTTP proxy configuration" },
    { name: "Meta", description: "API documentation and specification" },
    { name: "Applications", description: "Application management for headless API" },
    { name: "Application Packages", description: "Manage packages installed in an application" },
    {
      name: "Application Providers",
      description: "Manage provider credentials at the application level",
    },
    { name: "End Users", description: "End-user management for headless API" },
    { name: "Provider Keys", description: "Organization provider keys and credentials" },
  ],
} as const;
