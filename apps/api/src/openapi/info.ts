/**
 * OpenAPI info, servers, security defaults, and tags.
 */
export const openApiInfo = {
  openapi: "3.1.0",
  info: {
    title: "Appstrate API",
    version: "1.0.0",
    description:
      "API for Appstrate — an open-source platform for executing one-shot AI flows in ephemeral Docker containers. Manage flows, executions, schedules, providers, API keys, and more.",
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
    { name: "Marketplace", description: "Browse and install packages from Appstrate [registry]" },
    { name: "Packages", description: "Organization skills, extensions, and package management" },
    { name: "Notifications", description: "Execution notification management" },
    { name: "Organizations", description: "Organization and member management" },
    { name: "Profile", description: "User profile management" },
    { name: "Realtime", description: "Server-Sent Events (SSE) for real-time updates" },
    { name: "Connections", description: "Service connections (OAuth, API key)" },
    { name: "Invitations", description: "Organization invitation magic links" },
    { name: "Share", description: "Public share tokens for one-time execution" },
    { name: "Welcome", description: "Post-invite profile setup" },
    { name: "Health", description: "Health check" },
    { name: "Internal", description: "Container-to-host internal routes" },
    { name: "Models", description: "LLM model configuration" },
    { name: "Connection Profiles", description: "Shared connection sets across flows" },
    { name: "Registry", description: "Registry OAuth2 connection" },
    { name: "Proxies", description: "Org-level HTTP proxy configuration" },
    { name: "Meta", description: "API documentation and specification" },
  ],
} as const;
