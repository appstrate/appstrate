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

const OWN_ACCOUNT: RouteAccess = { open: "the caller's own account; no org or space permission" };
/**
 * One screen graded inside by what the caller may do. It reads the
 * organization-wide `/api/library`, which the server grades to the spaces where
 * the caller holds `spaces:read` — the floor here.
 */
const CATALOGUE: RouteAccess = { anyOf: ["spaces:read"], operations: ["getLibrary"] };
const WEBHOOKS_READ = ["webhooks:read", "org-webhooks:read"] as const;
const AGENT_SIGHT = packageSightPermissions("agent");

export const ROUTE_ACCESS = {
  "/": { open: "the fallback route: renders for any principal, its sections gate themselves" },

  "/agents": { anyOf: AGENT_SIGHT, operations: ["listAgents"] },
  "/agents/new": { anyOf: ["agents:write"], operations: ["createAgent"] },
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
  "/skills/:scope/:name": { anyOf: ["skills:read"], operations: ["getSkill"] },
  "/skills/:scope/:name/:version": {
    anyOf: ["skills:read"],
    operations: ["getSkillVersionDetail"],
  },

  "/integrations": { anyOf: ["integrations:read"], operations: ["listIntegrations"] },
  "/integrations/new": { anyOf: ["integrations:write"], operations: ["createIntegrationPackage"] },
  "/integrations/:scope/:name": { anyOf: ["integrations:read"], operations: ["getIntegration"] },

  "/mcp-servers": { anyOf: ["mcp-servers:read"], operations: ["listMcpServerPackages"] },
  "/mcp-servers/:scope/:name": { anyOf: ["mcp-servers:read"], operations: ["getMcpServerPackage"] },
  "/mcp-servers/:scope/:name/:version": {
    anyOf: ["mcp-servers:read"],
    operations: ["getMcpServerPackageVersionDetail"],
  },

  "/catalogue": CATALOGUE,
  "/catalogue/:reading/:type": CATALOGUE,

  "/preferences": OWN_ACCOUNT,
  "/preferences/general": OWN_ACCOUNT,
  "/preferences/appearance": OWN_ACCOUNT,
  "/preferences/security": OWN_ACCOUNT,
  "/preferences/devices": OWN_ACCOUNT,
  "/preferences/connections": OWN_ACCOUNT,
  "/preferences/mcp-access": OWN_ACCOUNT,
  // Its one read is the list, guarded read|connect; a personal credential's actions need `connect`.
  "/preferences/models": {
    anyOf: ["model-provider-credentials:read", "model-provider-credentials:connect"],
    operations: ["listModelProviderCredentials"],
  },

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

/** `path` is `prefix` or lies below it, segment by segment (`/catalogueX` is not under `/catalogue`). */
export const isUnder = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

/** What a settings page configures, and the API scope its requests carry. */
export type SettingsScope = "organization" | "workspace" | "account";

/** Each settings scope's index, the prefix of its pages. */
export const SETTINGS_INDEX = {
  organization: "/org-settings",
  workspace: "/workspace-settings",
  account: "/preferences",
} as const satisfies Record<SettingsScope, RoutePath>;

const SETTINGS_PREFIXES = Object.values(SETTINGS_INDEX);

export const isSettingsPath = (path: string) =>
  SETTINGS_PREFIXES.some((prefix) => isUnder(path, prefix));

/** The routed modals: mounted over the screen they were opened from, never in the main tree. */
export const OVERLAY_PREFIXES = [...SETTINGS_PREFIXES, "/catalogue"];

export const isOverlayPath = (path: string) =>
  OVERLAY_PREFIXES.some((prefix) => isUnder(path, prefix));

/**
 * The overlay tree's not-found routes, one per prefix: an address under an overlay that
 * none of its pages matches is answered there, not by the dashboard standing in.
 */
export const OVERLAY_NOT_FOUND_PATHS = OVERLAY_PREFIXES.map((prefix) => `${prefix}/*`);

/**
 * The agent page's Connexions (the Paramètres section `?agentSettings=connections`, and the
 * launch toast's « Connecter » link to it): its integration reads are not implied by the route.
 */
export function agentConnectionsTabVisible(can: (permission: Permission) => boolean): boolean {
  return can("integrations:read");
}

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
