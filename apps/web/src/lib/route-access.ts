// SPDX-License-Identifier: Apache-2.0

/**
 * Who reaches each SPA route under the main layout — ONE declaration, read by
 * the route gate (`RouteGate`), the sidebar and the settings tabs. A gated
 * route names the operations its page is built on and the permissions that
 * open it (any one suffices); `apps/api/test/unit/spa-route-access.test.ts`
 * pins those to the operations' real guards. `app.tsx` keys its pages by
 * `RoutePath`, so a route and its declaration cannot exist one without the other.
 *
 * Pure data: that API test imports this file, so nothing here may reach React,
 * the browser or the SPA's hooks.
 */

import { RUNS_READ_PERMISSIONS, type CorePermission } from "@appstrate/core/permissions";

/** A permission as the API guard spells it; module strings ride the open arm. */
type Permission = CorePermission | (string & {});

type RouteAccess = {
  /** Module feature flag (`features.<key>`) without which the route does not exist. */
  readonly feature?: string;
} & (
  | {
      readonly anyOf: readonly Permission[];
      /** OpenAPI operationIds the page is built on. */
      readonly operations: readonly string[];
    }
  | {
      /** Why no permission of the current space decides this route. */
      readonly open: string;
    }
);

const HOME_SPACE_EDITOR: RouteAccess = {
  open:
    "write authority is the package's HOME space (`home_writable`, RBAC spec §6.9), " +
    "which the editor reads off the loaded detail — not the space being browsed",
};
const OWN_ACCOUNT: RouteAccess = { open: "the caller's own account; no org or space permission" };
const WEBHOOKS_READ = ["webhooks:read", "org-webhooks:read"] as const;

export const ROUTE_ACCESS = {
  "/": { open: "the fallback route: renders for any principal, its sections gate themselves" },

  "/agents": { anyOf: ["agents:read", "agents:run"], operations: ["listAgents"] },
  "/agents/new": { anyOf: ["agents:write"], operations: ["createAgent"] },
  "/agents/:scope/:name/edit": HOME_SPACE_EDITOR,
  "/agents/:scope/:name": { anyOf: ["agents:read", "agents:run"], operations: ["getAgentPackage"] },
  // A version is the full manifest; `agents:run` reads only the summary (RBAC spec §3.4).
  "/agents/:scope/:name/:version": {
    anyOf: ["agents:read"],
    operations: ["getAgentVersionDetail"],
  },
  "/agents/:scope/:name/runs/:runId": { anyOf: RUNS_READ_PERMISSIONS, operations: ["getRun"] },
  "/runs": { anyOf: RUNS_READ_PERMISSIONS, operations: ["listRuns"] },
  "/files": { anyOf: ["files:read"], operations: ["listFiles"] },

  "/schedules": { anyOf: ["schedules:read"], operations: ["listSchedules"] },
  "/schedules/new": { anyOf: ["schedules:write"], operations: ["createSchedule"] },
  "/schedules/:id": { anyOf: ["schedules:read"], operations: ["getSchedule"] },
  "/schedules/:id/edit": { anyOf: ["schedules:write"], operations: ["updateSchedule"] },

  "/skills": { anyOf: ["skills:read"], operations: ["listSkills"] },
  "/skills/new": { anyOf: ["skills:write"], operations: ["createSkill"] },
  "/skills/:scope/:name/edit": HOME_SPACE_EDITOR,
  "/skills/:scope/:name": { anyOf: ["skills:read"], operations: ["getSkill"] },
  "/skills/:scope/:name/:version": {
    anyOf: ["skills:read"],
    operations: ["getSkillVersionDetail"],
  },

  "/integrations": { anyOf: ["integrations:read"], operations: ["listIntegrations"] },
  "/integrations/new": { anyOf: ["integrations:write"], operations: ["createIntegrationPackage"] },
  "/integrations/:scope/:name/edit": HOME_SPACE_EDITOR,
  "/integrations/:scope/:name": { anyOf: ["integrations:read"], operations: ["getIntegration"] },

  "/mcp-servers": { anyOf: ["mcp-servers:read"], operations: ["listMcpServerPackages"] },
  "/mcp-servers/:scope/:name/edit": HOME_SPACE_EDITOR,
  "/mcp-servers/:scope/:name": { anyOf: ["mcp-servers:read"], operations: ["getMcpServerPackage"] },
  "/mcp-servers/:scope/:name/:version": {
    anyOf: ["mcp-servers:read"],
    operations: ["getMcpServerPackageVersionDetail"],
  },

  "/space/packages": { anyOf: ["spaces:read"], operations: ["listSpacePackages"] },
  "/library": {
    open: "an organization role rule (owner/admin, `RequireOrgCatalogAdmin`), not a permission",
  },

  "/preferences": OWN_ACCOUNT,
  "/preferences/general": OWN_ACCOUNT,
  "/preferences/appearance": OWN_ACCOUNT,
  "/preferences/security": OWN_ACCOUNT,
  "/preferences/devices": OWN_ACCOUNT,
  "/preferences/connections": OWN_ACCOUNT,

  // The page lists both levels. The detail's guard is the ROW's level, resolved
  // in the handler (`loadWebhookForAction`), so only the list pins the pair.
  "/webhooks": { feature: "webhooks", anyOf: WEBHOOKS_READ, operations: ["listWebhooks"] },
  "/webhooks/:id": { feature: "webhooks", anyOf: WEBHOOKS_READ, operations: ["getWebhook"] },

  "/chat": { feature: "chat", anyOf: ["chat:read"], operations: ["listChatSessions"] },
  "/chat/:conversationId": {
    feature: "chat",
    anyOf: ["chat:read"],
    operations: ["getChatSession"],
  },

  "/end-users": { anyOf: ["end-users:read"], operations: ["listEndUsers"] },

  "/org-settings": { open: "layout only: the index redirects to general, every tab gates itself" },
  // `GET /api/orgs/{orgId}` asks membership only (every org role holds
  // `org:read`); the member list in it is filtered on `members:read` by the handler.
  "/org-settings/general": { anyOf: ["org:read"], operations: ["getOrganization"] },
  "/org-settings/members": { anyOf: ["members:read"], operations: ["getOrganization"] },
  "/org-settings/roles": { anyOf: ["roles:read"], operations: ["listRoles"] },
  "/org-settings/spaces": { anyOf: ["spaces:read"], operations: ["listSpaces"] },
  "/org-settings/models": { anyOf: ["models:read"], operations: ["listModels"] },
  "/org-settings/proxies": { anyOf: ["proxies:read"], operations: ["listProxies"] },
  "/org-settings/oauth": {
    feature: "oidc",
    anyOf: ["oauth-clients:read"],
    operations: ["listOAuthClients"],
  },
  "/org-settings/cli-sessions": {
    feature: "oidc",
    anyOf: ["cli-sessions:read"],
    operations: ["listOrgCliSessions"],
  },
  "/org-settings/billing": {
    feature: "billing",
    anyOf: ["billing:read"],
    operations: ["getEeBillingAccount"],
  },
  "/org-settings/space/general": { anyOf: ["space-settings:write"], operations: ["updateSpace"] },
  // An inviter who may not list members still reaches the add-member form.
  "/org-settings/space/members": {
    anyOf: ["space-members:read", "space-members:invite"],
    operations: ["listSpaceMembers", "addSpaceMember"],
  },
  "/org-settings/space/api-keys": { anyOf: ["api-keys:read"], operations: ["listApiKeys"] },
  "/org-settings/space/auth": {
    feature: "oidc",
    anyOf: ["space-settings:write"],
    operations: ["getSpaceSmtpConfig"],
  },
  "/org-settings/space/oauth": {
    feature: "oidc",
    anyOf: ["oauth-clients:read"],
    operations: ["listOAuthClients"],
  },
} satisfies Record<string, RouteAccess>;

export type RoutePath = keyof typeof ROUTE_ACCESS;

/** `absent`: the module behind the route is not loaded, so the route does not exist. */
type RouteVerdict = "absent" | "granted" | "denied";

export function routeVerdict(
  path: RoutePath,
  can: (permission: Permission) => boolean,
  features: Readonly<Record<string, boolean | undefined>>,
): RouteVerdict {
  const access: RouteAccess = ROUTE_ACCESS[path];
  if (access.feature && !features[access.feature]) return "absent";
  if ("open" in access) return "granted";
  return access.anyOf.some(can) ? "granted" : "denied";
}
