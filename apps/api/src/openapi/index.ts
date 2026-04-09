// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI 3.1 specification for the Appstrate API.
 * Assembled from sub-modules — no runtime code generation.
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
import { providerKeysPaths } from "./paths/provider-keys.ts";
import { proxiesPaths } from "./paths/proxies.ts";
import { connectionProfilesPaths } from "./paths/connection-profiles.ts";
import { appProfilesPaths } from "./paths/app-profiles.ts";
import { apiKeysPaths } from "./paths/api-keys.ts";
import { organizationsPaths } from "./paths/organizations.ts";
import { profilePaths } from "./paths/profile.ts";
import { invitationsPaths } from "./paths/invitations.ts";
import { internalPaths } from "./paths/internal.ts";
import { welcomePaths } from "./paths/welcome.ts";
import { metaPaths } from "./paths/meta.ts";
import { notificationsPaths } from "./paths/notifications.ts";
import { packagesPaths } from "./paths/packages.ts";
import { webhooksPaths } from "./paths/webhooks.ts";
import { applicationsPaths } from "./paths/applications.ts";
import { endUsersPaths } from "./paths/end-users.ts";
import { oauthClientsPaths } from "./paths/oauth-clients.ts";

export const openApiSpec = {
  ...openApiInfo,
  paths: {
    ...healthPaths,
    ...authPaths,
    ...agentsPaths,
    ...runsPaths,
    ...realtimePaths,
    ...schedulesPaths,
    ...connectionsPaths,
    ...providersPaths,
    ...modelsPaths,
    ...providerKeysPaths,
    ...proxiesPaths,
    ...connectionProfilesPaths,
    ...appProfilesPaths,
    ...apiKeysPaths,
    ...organizationsPaths,
    ...profilePaths,
    ...invitationsPaths,
    ...internalPaths,
    ...welcomePaths,
    ...metaPaths,
    ...notificationsPaths,
    ...packagesPaths,
    ...webhooksPaths,
    ...applicationsPaths,
    ...endUsersPaths,
    ...oauthClientsPaths,
  },
  components: {
    securitySchemes,
    parameters,
    headers,
    schemas,
    responses,
  },
} as const;
