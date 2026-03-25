/**
 * OpenAPI info, servers, security defaults, and tags.
 */
export const openApiInfo = {
  openapi: "3.1.0",
  info: {
    title: "Appstrate API",
    version: "1.0.0",
    description:
      "API for Appstrate — an open-source platform for executing one-shot AI flows in ephemeral Docker containers. Manage flows, executions, schedules, providers, API keys, and more.\n\n## Common Response Headers\n\nAll API responses include a `Request-Id` header (`req_` prefix) for tracing. All authenticated responses additionally include an `Appstrate-Version` header with the resolved API version (format: `YYYY-MM-DD`). Deprecated API versions include a `Sunset` header (RFC 8594). Rate-limited endpoints return `RateLimit` and `RateLimit-Policy` headers on every response (not just 429).",
    contact: {
      name: "Appstrate",
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
    { name: "Flows", description: "Flow management" },
    { name: "Executions", description: "Flow execution and logs" },
    { name: "Schedules", description: "Cron scheduling" },
    { name: "Providers", description: "Provider configuration (OAuth2, API key, etc.)" },
    { name: "API Keys", description: "API key management for programmatic access" },
    { name: "Packages", description: "Organization skills, tools, and package management" },
    { name: "Notifications", description: "Execution notification management" },
    { name: "Organizations", description: "Organization and member management" },
    { name: "Profile", description: "User profile management" },
    { name: "Realtime", description: "Server-Sent Events (SSE) for real-time updates" },
    { name: "Connections", description: "Provider connections (OAuth, API key)" },
    { name: "Invitations", description: "Organization invitation magic links" },
    { name: "Share", description: "Managed share links for flow execution" },
    { name: "Share Links", description: "Share link CRUD for authenticated users" },
    { name: "Welcome", description: "Post-invite profile setup" },
    { name: "Health", description: "Health check" },
    { name: "Internal", description: "Container-to-host internal routes" },
    { name: "Models", description: "LLM model configuration" },
    { name: "Connection Profiles", description: "Shared connection sets across flows" },
    { name: "Proxies", description: "Org-level HTTP proxy configuration" },
    { name: "Meta", description: "API documentation and specification" },
    { name: "Applications", description: "Application management for headless API" },
    { name: "End Users", description: "End-user management for headless API" },
    { name: "Provider Keys", description: "Organization provider keys and credentials" },
    { name: "Webhooks", description: "Webhook configuration and delivery" },
  ],
} as const;
