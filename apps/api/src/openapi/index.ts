// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI 3.1 specification for the Appstrate API.
 *
 * Core paths are assembled statically. Module-owned paths are contributed
 * dynamically via `openApiPaths()` — they only appear when the module is
 * loaded.
 *
 * Call `buildOpenApiSpec()` after modules are initialized to get the
 * final spec with all module contributions merged in.
 */
import { openApiInfo } from "./info.ts";
import { schemas } from "./schemas.ts";
import { responses } from "./responses.ts";
import { parameters } from "./parameters.ts";
import { headers } from "./headers.ts";
import { securitySchemes } from "./security-schemes.ts";

// Path modules
import { healthPaths } from "./paths/health.ts";
import { authPaths } from "./paths/auth.ts";
import { agentsPaths } from "./paths/agents.ts";
import { runsPaths } from "./paths/runs.ts";
import { realtimePaths } from "./paths/realtime.ts";
import { schedulesPaths } from "./paths/schedules.ts";
import { connectionsPaths } from "./paths/connections.ts";
import { providersPaths } from "./paths/providers.ts";
import { modelsPaths } from "./paths/models.ts";
import { modelProviderCredentialsPaths } from "./paths/model-provider-credentials.ts";
import { modelProvidersOAuthPaths } from "./paths/model-providers-oauth.ts";
import { proxiesPaths } from "./paths/proxies.ts";
import { connectionProfilesPaths } from "./paths/connection-profiles.ts";
import { appProfilesPaths } from "./paths/app-profiles.ts";
import { apiKeysPaths } from "./paths/api-keys.ts";
import { organizationsPaths } from "./paths/organizations.ts";
import { profilePaths } from "./paths/profile.ts";
import { mePaths } from "./paths/me.ts";
import { invitationsPaths } from "./paths/invitations.ts";
import { internalPaths } from "./paths/internal.ts";
import { welcomePaths } from "./paths/welcome.ts";
import { metaPaths } from "./paths/meta.ts";
import { notificationsPaths } from "./paths/notifications.ts";
import { packagesPaths } from "./paths/packages.ts";
import { applicationsPaths } from "./paths/applications.ts";
import { endUsersPaths } from "./paths/end-users.ts";
import { uploadsPaths } from "./paths/uploads.ts";
import { credentialProxyPaths } from "./paths/credential-proxy.ts";
import { llmProxyPaths } from "./paths/llm-proxy.ts";
import { libraryPaths } from "./paths/library.ts";

const corePaths = {
  ...healthPaths,
  ...authPaths,
  ...agentsPaths,
  ...runsPaths,
  ...realtimePaths,
  ...schedulesPaths,
  ...connectionsPaths,
  ...providersPaths,
  ...modelsPaths,
  ...modelProviderCredentialsPaths,
  ...modelProvidersOAuthPaths,
  ...proxiesPaths,
  ...connectionProfilesPaths,
  ...appProfilesPaths,
  ...apiKeysPaths,
  ...organizationsPaths,
  ...profilePaths,
  ...mePaths,
  ...invitationsPaths,
  ...internalPaths,
  ...welcomePaths,
  ...metaPaths,
  ...notificationsPaths,
  ...packagesPaths,
  ...applicationsPaths,
  ...endUsersPaths,
  ...uploadsPaths,
  ...credentialProxyPaths,
  ...llmProxyPaths,
  ...libraryPaths,
};

const components = {
  securitySchemes,
  parameters,
  headers,
  schemas,
  responses,
};

/**
 * Build the final OpenAPI spec by merging core paths and schemas with module contributions.
 * Must be called after modules are initialized (or after static filesystem discovery
 * in build-time scripts).
 */
export function buildOpenApiSpec(
  modulePaths: Record<string, unknown> = {},
  moduleComponentSchemas: Record<string, unknown> = {},
  moduleTags: ReadonlyArray<{ name: string; description?: string }> = [],
) {
  return {
    ...openApiInfo,
    tags: [...openApiInfo.tags, ...moduleTags],
    paths: {
      ...corePaths,
      ...modulePaths,
    },
    components: {
      ...components,
      schemas: {
        ...schemas,
        ...moduleComponentSchemas,
      },
    },
  } as const;
}
