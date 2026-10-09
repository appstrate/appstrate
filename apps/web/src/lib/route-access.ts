// SPDX-License-Identifier: Apache-2.0

/**
 * Who reaches each route of the signed-in app — the main layout's pages, the
 * chat's own shell and the overlay surfaces (catalogue, settings, preferences).
 * One declaration, read by `RouteGate` and the shell's links; `anyOf` is pinned
 * to the named operations' guards by `apps/api/test/unit/spa-route-access.test.ts`.
 * Pure data: that API test imports it, so nothing here may reach React.
 */

import {
  packageSightPermissions,
  RUNS_READ_PERMISSIONS,
  type CorePermission,
} from "@appstrate/core/permissions";

/** A permission as the API guard spells it; module strings ride the open arm. */
type Permission = CorePermission | (string & {});

type RouteAccess = {
  /** Module feature flag (`features.<key>`) without which the route does not exist. */
  readonly feature?: string;
  /** Absent in a personal space: the server refuses its writes there (409 `personal_space_*`). */
  readonly teamSpaceOnly?: true;
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
/**
 * One screen graded inside by what the caller may do. Its floor is the space's
 * own library read; the organization-wide `/api/library` an owner or admin also
 * reads is a role rule in its handler, not a guard.
 */
const CATALOGUE: RouteAccess = { anyOf: ["spaces:read"], operations: ["getSpaceLibrary"] };
const WEBHOOKS_READ = ["webhooks:read", "org-webhooks:read"] as const;
const AGENT_SIGHT = packageSightPermissions("agent");

export const ROUTE_ACCESS = {
  "/": { open: "the fallback route: renders for any principal, its sections gate themselves" },

  "/agents": { anyOf: AGENT_SIGHT, operations: ["listAgents"] },
  "/agents/new": { anyOf: ["agents:write"], operations: ["createAgent"] },
  "/agents/:scope/:name/edit": HOME_SPACE_EDITOR,
  "/agents/:scope/:name": { anyOf: AGENT_SIGHT, operations: ["getAgentPackage"] },
  // A version is the full manifest; `agents:run` reads only the summary (RBAC spec §3.4).
  "/agents/:scope/:name/:version": {
    anyOf: ["agents:read"],
    operations: ["getAgentVersionDetail"],
  },
  "/agents/:scope/:name/runs/:runId": { anyOf: RUNS_READ_PERMISSIONS, operations: ["getRun"] },
  "/runs": { anyOf: RUNS_READ_PERMISSIONS, operations: ["listRuns"] },
  "/files": { anyOf: ["files:read"], operations: ["listFiles"] },

  "/schedules": { anyOf: ["schedules:read"], operations: ["listSchedules"] },
  "/schedules/:id": { anyOf: ["schedules:read"], operations: ["getSchedule"] },

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

  "/catalogue": CATALOGUE,
  "/catalogue/:origin/:type": CATALOGUE,

  "/preferences": OWN_ACCOUNT,
  "/preferences/general": OWN_ACCOUNT,
  "/preferences/appearance": OWN_ACCOUNT,
  "/preferences/security": OWN_ACCOUNT,
  "/preferences/devices": OWN_ACCOUNT,
  "/preferences/connections": OWN_ACCOUNT,
  "/preferences/mcp-access": OWN_ACCOUNT,

  "/chat": { feature: "chat", anyOf: ["chat:read"], operations: ["listChatSessions"] },
  "/chat/:conversationId": {
    feature: "chat",
    anyOf: ["chat:read"],
    operations: ["getChatSession"],
  },

  "/org-settings": {
    open: "layout only: the index opens the rail's first entry, every tab gates itself",
  },
  // The org read asks membership only; its handler filters the member list on `members:read`.
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

  "/workspace-settings": {
    open: "layout only: the index opens the rail's first entry, every tab gates itself",
  },
  "/workspace-settings/general": { anyOf: ["space-settings:write"], operations: ["updateSpace"] },
  // An inviter who may not list members still reaches the add-member form.
  "/workspace-settings/members": {
    teamSpaceOnly: true,
    anyOf: ["space-members:read", "space-members:invite"],
    operations: ["listSpaceMembers", "addSpaceMember"],
  },
  "/workspace-settings/auth": {
    feature: "oidc",
    anyOf: ["space-settings:write"],
    operations: ["getSpaceSmtpConfig"],
  },
  "/workspace-settings/api-keys": {
    teamSpaceOnly: true,
    anyOf: ["api-keys:read"],
    operations: ["listApiKeys"],
  },
  "/workspace-settings/oauth": {
    feature: "oidc",
    teamSpaceOnly: true,
    anyOf: ["oauth-clients:read"],
    operations: ["listOAuthClients"],
  },
  "/workspace-settings/end-users": {
    teamSpaceOnly: true,
    anyOf: ["end-users:read"],
    operations: ["listEndUsers"],
  },
  // Both levels; the detail's guard is the row's level, resolved in its handler.
  "/workspace-settings/webhooks": {
    feature: "webhooks",
    anyOf: WEBHOOKS_READ,
    operations: ["listWebhooks"],
  },
  "/workspace-settings/webhooks/:id": {
    feature: "webhooks",
    anyOf: WEBHOOKS_READ,
    operations: ["getWebhook"],
  },
} satisfies Record<string, RouteAccess>;

export type RoutePath = keyof typeof ROUTE_ACCESS;

/** `absent`: the route does not exist here (module not loaded, or team-space route in a personal space). */
type RouteVerdict = "absent" | "granted" | "denied";

export function routeVerdict(
  path: RoutePath,
  can: (permission: Permission) => boolean,
  features: Readonly<Record<string, boolean | undefined>>,
  inPersonalSpace: boolean,
): RouteVerdict {
  const access: RouteAccess = ROUTE_ACCESS[path];
  if (access.feature && !features[access.feature]) return "absent";
  if (access.teamSpaceOnly && inPersonalSpace) return "absent";
  if ("open" in access) return "granted";
  return access.anyOf.some(can) ? "granted" : "denied";
}
