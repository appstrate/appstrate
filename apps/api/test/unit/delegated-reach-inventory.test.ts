// SPDX-License-Identifier: Apache-2.0

/**
 * Deny-by-default inventory for delegated credentials (OWASP API5:2023). Every
 * documented operation whose route declares no guard at all — no requirement,
 * no target-space requirement, no ceiling — must be classified here with the
 * reason it is safe for an API key or OIDC token. A new unguarded route fails
 * until its author declares a guard or classifies it; a classified operation
 * that gained a guard (or disappeared) fails too, so the list never goes stale.
 */

import { describe, it, expect } from "bun:test";
import { registerTestPlatformApp } from "../helpers/platform-app.ts";
import { getPlatformOperations } from "../../src/lib/platform-app.ts";
import { getModules } from "../../src/lib/modules/module-loader.ts";

await registerTestPlatformApp();

/** No `ownership` category on purpose: an act authorized by "the caller owns
 *  the row" must still cap a delegate with `requireCeiling`/`requireAnyCeiling`. */
type UndeclaredCategory = "public" | "user-only" | "internal" | "handler-guarded" | "self";

interface Classification {
  readonly category: UndeclaredCategory;
  readonly reason: string;
  /** Id of the opt-in module that documents the operation; absent from the
   *  surface (without being stale) only while that module is not loaded. */
  readonly module?: string;
}

const UNDECLARED_OPERATIONS: Readonly<Record<string, Classification>> = {
  // public — pre-auth or protocol endpoints: no Appstrate bearer is consulted;
  // the credential is the token/code/cookie the request itself carries.
  cliRevoke: {
    category: "public",
    reason: "RFC 7009: possession of the refresh token + validateClientOrThrow",
  },
  cliToken: {
    category: "public",
    reason: "validateClientOrThrow + approved device_code or refresh token",
  },
  deviceActivateGet: {
    category: "public",
    reason: "RFC 8628 code-entry page; consent half needs a Better Auth session",
  },
  deviceActivateSubmit: {
    category: "public",
    reason: "CSRF double-submit form post, redirects only, no state change",
  },
  deviceAuthorizationCode: {
    category: "public",
    reason: "RFC 8628 endpoint gated by validateDeviceFlowClient + per-IP limit",
  },
  getHealth: {
    category: "public",
    reason: "liveness/readiness probe mounted before auth, no tenant data",
  },
  getIntegrationConnectContext: {
    category: "public",
    reason: "signed connect page cookie; manifest display data only",
  },
  getInvitationInfo: { category: "public", reason: "invitation token in URL is the credential" },
  getOpenApiSpec: { category: "public", reason: "static instance spec, skipAuth" },
  getSwaggerUI: { category: "public", reason: "static Swagger UI shell, skipAuth" },
  integrationsOAuthCallback: {
    category: "public",
    reason: "server-side OAuth state minted under integrations:connect",
  },
  mcpProtectedResourceMetadata: { category: "public", reason: "RFC 9728 static metadata" },
  oauth2Introspect: { category: "public", reason: "RFC 7662, client credentials required" },
  oauth2Jwks: { category: "public", reason: "public signing keys" },
  oauth2Revoke: {
    category: "public",
    reason: "RFC 7009, client credentials required, own client's tokens only",
  },
  oauth2Token: {
    category: "public",
    reason: "client credentials + code/refresh_token grant, RFC 8707 resource guard",
  },
  oauthLogout: {
    category: "public",
    reason: "Better Auth signOut, acts on a BA session cookie only",
  },
  oauthServerMetadata: { category: "public", reason: "RFC 8414 static metadata" },
  oauthServerMetadataPathInserted: {
    category: "public",
    reason: "RFC 8414 static metadata (path-inserted form)",
  },
  oidcDiscovery: { category: "public", reason: "OIDC discovery static metadata" },
  oidcDiscoveryPathInserted: {
    category: "public",
    reason: "OIDC discovery static metadata (path-inserted form)",
  },
  redeemBootstrapToken: {
    category: "public",
    reason: "timing-safe AUTH_BOOTSTRAP_TOKEN compare, dead once an org exists",
  },
  redeemOAuthModelProviderPairing: {
    category: "public",
    reason: "single-use appp_ pairing bearer; other bearers 401",
  },
  signInEmail: { category: "public", reason: "email + password in body is the credential" },
  signUpEmail: {
    category: "public",
    reason: "unauthenticated account creation; a bearer adds nothing",
  },
  startIntegrationConnect: {
    category: "public",
    reason: "signed single-use connect token minted under integrations:connect",
  },
  submitIntegrationConnect: {
    category: "public",
    reason: "signed page cookie + CSRF, claims minted under integrations:connect",
  },
  writeUploadContent: {
    category: "public",
    reason: "verifyFsUploadToken HMAC minted by createUpload",
  },
  receiveEeBillingStripeWebhook: {
    category: "public",
    reason: "Stripe webhook, stripe-signature verified",
    module: "ee",
  },

  // user-only — refuses every delegate: needs a Better Auth session or a user principal.
  acceptInvitation: {
    category: "user-only",
    reason: "Better Auth session whose email matches the invitation",
  },
  cliListSessions: {
    category: "user-only",
    reason: "Better Auth session only (getSessionFromCtx)",
  },
  cliRevokeAllSessions: {
    category: "user-only",
    reason: "Better Auth session only (getSessionFromCtx)",
  },
  cliRevokeSession: {
    category: "user-only",
    reason: "Better Auth session only, scoped to session.user.id",
  },
  createOrganization: { category: "user-only", reason: "isUserPrincipal" },
  deviceActivateApprove: {
    category: "user-only",
    reason: "CSRF + Better Auth session (deviceApprove)",
  },
  deviceActivateDeny: { category: "user-only", reason: "CSRF + Better Auth session (deviceDeny)" },
  getLibrary: { category: "user-only", reason: "isUserPrincipal ∧ org owner|admin" },
  getProfile: { category: "user-only", reason: "isUserPrincipal" },
  getSession: { category: "user-only", reason: "Better Auth session cookie only" },
  leaveOrganization: {
    category: "user-only",
    reason: "authMethod === session (dashboard cookie only)",
  },
  listStorageDeletionJobs: {
    category: "user-only",
    reason: "requirePlatformAdmin: platform-realm session + allowlist",
  },
  oauth2Authorize: {
    category: "user-only",
    reason: "Better Auth session only; consent is the human's",
  },
  retryStorageDeletionJob: {
    category: "user-only",
    reason: "requirePlatformAdmin: platform-realm session + allowlist",
  },
  setProfilePassword: { category: "user-only", reason: "isUserPrincipal" },
  signOut: { category: "user-only", reason: "Better Auth session cookie only" },
  updateProfile: { category: "user-only", reason: "isUserPrincipal" },
  welcomeSetup: { category: "user-only", reason: "isUserPrincipal" },

  // internal — runner/sidecar channels authenticated by an HMAC-signed run
  // token or signature; an API key or OIDC bearer fails verification.
  fetchRunFile: { category: "internal", reason: "verifyRunSignature" },
  fetchRunFilesManifest: { category: "internal", reason: "verifyRunSignature" },
  fetchRunWorkspace: { category: "internal", reason: "verifyRunSignature" },
  finalizeRemoteRun: { category: "internal", reason: "verifyRunSignature" },
  getIntegrationCredentials: {
    category: "internal",
    reason: "signed connect-run grant or verifyRunToken",
  },
  getMcpServerBundle: {
    category: "internal",
    reason: "signed connect-run grant or verifyRunToken",
  },
  getOAuthModelProviderToken: { category: "internal", reason: "verifyRunToken" },
  getRunHistory: { category: "internal", reason: "verifyRunToken" },
  heartbeatRemoteRun: { category: "internal", reason: "verifyRunSignature" },
  ingestRunEvent: { category: "internal", reason: "verifyRunSignature" },
  publishRunFile: { category: "internal", reason: "verifyRunUploadSignature" },
  recallMemories: { category: "internal", reason: "verifyRunToken" },
  refreshIntegrationCredentials: {
    category: "internal",
    reason: "signed connect-run grant or verifyRunToken",
  },
  refreshOAuthModelProviderToken: { category: "internal", reason: "verifyRunToken" },
  runLlmProxyAnthropicMessages: { category: "internal", reason: "verifyRunToken" },
  runLlmProxyMistralChatCompletions: { category: "internal", reason: "verifyRunToken" },
  runLlmProxyOpenaiChatCompletions: { category: "internal", reason: "verifyRunToken" },
  runLlmProxyOpenaiResponses: { category: "internal", reason: "verifyRunToken" },

  // handler-guarded — the permission is checked inside the handler (or by a
  // guard the route table cannot read) against the ceiling-applied permission set.
  activatePackage: {
    category: "handler-guarded",
    reason:
      "gateSpacePackageWrite: per-type activate permission (+ <type>:share in home when unplaced)",
  },
  createAgentVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: agents:write in home space",
  },
  createIntegrationPackageVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: integrations:write in home space",
  },
  createMcpServerPackageVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: mcp-servers:write in home space",
  },
  createSkillVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: skills:write in home space",
  },
  deactivatePackage: {
    category: "handler-guarded",
    reason: "gateSpacePackageWrite: per-type deactivate permission",
  },
  deleteAgent: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: agents:delete in home space",
  },
  deleteAgentVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: agents:delete in home space",
  },
  deleteFile: {
    category: "handler-guarded",
    reason: "getFileForActor: files:delete, or creator with fileLifecycleCeiling admitting it",
  },
  deleteIntegrationPackage: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: integrations:delete in home space",
  },
  deleteIntegrationPackageVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: integrations:delete in home space",
  },
  deleteMcpServerPackage: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: mcp-servers:delete in home space",
  },
  deleteMcpServerPackageVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: mcp-servers:delete in home space",
  },
  deleteSkill: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: skills:delete in home space",
  },
  deleteSkillVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: skills:delete in home space",
  },
  deleteWebhook: {
    category: "handler-guarded",
    reason: "loadWebhookForAction: webhooks:delete|org-webhooks:delete",
  },
  downloadPackageVersion: {
    category: "handler-guarded",
    reason:
      "requirePackageReadPermission: <type>:read (+ home authority for draft/copy-restricted)",
  },
  getPackageFileContent: {
    category: "handler-guarded",
    reason: "loadFileExplorerPackage → requirePackageReadPermission: <type>:read",
  },
  getPackageHome: {
    category: "handler-guarded",
    reason: "resolvePackageHome: <type>:read in an accessible placing space, else 404",
  },
  getWebhook: {
    category: "handler-guarded",
    reason: "loadWebhookForAction: webhooks:read|org-webhooks:read",
  },
  keepFile: {
    category: "handler-guarded",
    reason: "getFileForActor: files:delete, or creator with fileLifecycleCeiling admitting it",
  },
  listPackageFiles: {
    category: "handler-guarded",
    reason: "loadFileExplorerPackage → requirePackageReadPermission: <type>:read",
  },
  listPackageShares: {
    category: "handler-guarded",
    reason: "assertPackageShareAccess: <type>:share in home space",
  },
  listWebhookDeliveries: {
    category: "handler-guarded",
    reason: "loadWebhookForAction: webhooks:read|org-webhooks:read",
  },
  movePackageHome: {
    category: "handler-guarded",
    reason: "assertPackageMutationAccess: <type>:write in home and in destination",
  },
  restoreAgentVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: agents:write in home space",
  },
  restoreIntegrationPackageVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: integrations:write in home space",
  },
  restoreMcpServerPackageVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: mcp-servers:write in home space",
  },
  restoreSkillVersion: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: skills:write in home space",
  },
  revokePackageShare: {
    category: "handler-guarded",
    reason: "assertPackageShareAccess: <type>:share in home space",
  },
  rotateWebhookSecret: {
    category: "handler-guarded",
    reason: "loadWebhookForAction: webhooks:write|org-webhooks:write",
  },
  sharePackage: {
    category: "handler-guarded",
    reason: "assertPackageShareAccess: <type>:share in home space",
  },
  streamAgentRuns: {
    category: "handler-guarded",
    reason: "validateSSEAuth: ceilinged canReadRuns",
  },
  streamAllRuns: { category: "handler-guarded", reason: "validateSSEAuth: ceilinged canReadRuns" },
  streamRun: {
    category: "handler-guarded",
    reason: "validateSSEAuth: ceilinged canReadRuns + run ownership or read-all",
  },
  testWebhook: {
    category: "handler-guarded",
    reason: "loadWebhookForAction: webhooks:write|org-webhooks:write",
  },
  updateAgent: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: agents:write in home space",
  },
  updateIntegrationPackage: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: integrations:write in home space",
  },
  updateMcpServerPackage: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: mcp-servers:write in home space",
  },
  updateSkill: {
    category: "handler-guarded",
    reason: "requirePackageInOrg → assertPackageMutationAccess: skills:write in home space",
  },
  updateSpacePackage: {
    category: "handler-guarded",
    reason: "gateSpacePackageWrite: per-type configure permission",
  },
  updateWebhook: {
    category: "handler-guarded",
    reason: "loadWebhookForAction: webhooks:write|org-webhooks:write",
  },

  // self — describes the credential itself (its own identity, bound org and
  // ceiling-applied permissions); a delegate needs it to function.
  getMyContext: {
    category: "self",
    reason: "identity + org role; every enrichment gated on ceilinged callerPermissions",
  },
  getOrganization: {
    category: "self",
    reason: "bound org's own non-secret identity; members/invitations gated in-handler",
  },
  getOrgSettings: {
    category: "self",
    reason: "bound org's own non-secret config (api_version, sso, copy policy)",
  },
  listMyOrgs: {
    category: "self",
    reason: "filtered to the credential's bound org, ceiling-applied permissions",
  },
  listOrganizations: {
    category: "self",
    reason: "non-user principals filtered to their bound org, ceiling-applied permissions",
  },
  oauth2Userinfo: {
    category: "self",
    reason: "OIDC userinfo of the token's own subject, scope-filtered claims",
  },
};

function undeclaredOperationIds(): Set<string> {
  const ids = new Set<string>();
  for (const op of getPlatformOperations().operations) {
    const { requirements, targetSpaceRequirements, ceilingRequirements } = op.requirement;
    if (
      requirements.length === 0 &&
      targetSpaceRequirements.length === 0 &&
      ceilingRequirements.length === 0
    ) {
      ids.add(op.operationId);
    }
  }
  return ids;
}

describe("delegated reach inventory", () => {
  it("classifies every operation whose route declares no guard, and nothing else", () => {
    const undeclared = undeclaredOperationIds();
    const classified = new Set(Object.keys(UNDECLARED_OPERATIONS));
    const missing = [...undeclared].filter((id) => !classified.has(id)).sort();
    const documented = new Set(getPlatformOperations().operations.map((op) => op.operationId));
    const loaded = getModules();
    const stale = [...classified]
      .filter((id) => {
        if (undeclared.has(id)) return false;
        const owner = UNDECLARED_OPERATIONS[id]!.module;
        // Absent only because its module is not loaded here (e.g. module-ee at tier 0).
        return !(owner !== undefined && !loaded.has(owner) && !documented.has(id));
      })
      .sort();

    const problems: string[] = [];
    if (missing.length > 0) {
      problems.push(
        `Operations whose route declares no guard (no requirePermission, no space re-scoped guard, no requireCeiling):\n` +
          missing.map((id) => `  - ${id}`).join("\n") +
          `\nAn API key or OIDC token with ANY scope reaches them. Declare a guard on the route — ` +
          `an act authorized by row ownership ("the caller's own …") declares requireCeiling/requireAnyCeiling — ` +
          `or, if no scope can apply, classify it in UNDECLARED_OPERATIONS with a category and a one-line reason naming the check.`,
      );
    }
    if (stale.length > 0) {
      problems.push(
        `Classified operations that now declare a guard, or no longer exist:\n` +
          stale.map((id) => `  - ${id}`).join("\n") +
          `\nRemove them from UNDECLARED_OPERATIONS.`,
      );
    }
    expect(problems.join("\n\n")).toBe("");
  });

  it("covers a non-trivial surface and excludes a known guarded operation", () => {
    const undeclared = undeclaredOperationIds();
    expect(undeclared.size).toBeGreaterThan(50);
    expect(getPlatformOperations().operations.some((op) => op.operationId === "runAgent")).toBe(
      true,
    );
    expect(undeclared.has("runAgent")).toBe(false);
    expect("runAgent" in UNDECLARED_OPERATIONS).toBe(false);
  });
});
