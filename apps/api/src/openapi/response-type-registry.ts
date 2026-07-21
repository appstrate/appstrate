// SPDX-License-Identifier: Apache-2.0

/**
 * Registry mapping OpenAPI response schemas to the `@appstrate/shared-types`
 * interface they are supposed to mirror, consumed by verify-openapi step #7
 * ("Shared-Type ↔ OpenAPI Response Required-Field Comparison").
 *
 * The check asserts that every field a shared-type marks **required** is also
 * marked required in the matching OpenAPI response schema (for fields the spec
 * declares as properties). It catches the "spec marks a response field optional
 * that the consuming type marks required" class of drift — the frontend trusts
 * the generated type and reads `.x` unconditionally, but the spec permits the
 * server to omit it.
 *
 * SEEDING POLICY: only pairs with **zero** current violations belong here, so
 * the gate is green on day one. Expand it schema-by-schema as response schemas
 * are tightened to match their types.
 *
 * Each entry targets either:
 *   - a named component schema (`specSchemaName`), resolved from
 *     `components.schemas[name]`, or
 *   - an inline response schema (`path` + `method` + `status`), resolved from
 *     `paths[path][method].responses[status].content["application/json"].schema`.
 */

export type ResponseTypeEntry = {
  /** Named component schema under `components.schemas`. Mutually exclusive with path/method/status. */
  specSchemaName?: string;
  /** Inline response: spec path (e.g. "/api/agents/{scope}/{name}/proxy"). */
  path?: string;
  /** Inline response: HTTP method (lowercase). */
  method?: string;
  /** Inline response: status code (e.g. "200"). */
  status?: string;
  /** Exported interface name in `@appstrate/shared-types`. */
  sharedTypeName: string;
  /** Human-readable label used in the verifier's per-entry output. */
  description: string;
};

export const responseTypeRegistry: ResponseTypeEntry[] = [
  {
    specSchemaName: "EndUserObject",
    sharedTypeName: "EndUserInfo",
    description: "EndUserObject ↔ EndUserInfo",
  },
  {
    specSchemaName: "IntegrationAgentResolution",
    sharedTypeName: "IntegrationAgentResolution",
    description: "IntegrationAgentResolution (bulk readiness integrations[].resolution)",
  },
  {
    specSchemaName: "Run",
    sharedTypeName: "EnrichedRun",
    description: "Run ↔ EnrichedRun (every run response is enriched via mapEnrichedRun)",
  },
  {
    specSchemaName: "Schedule",
    sharedTypeName: "EnrichedSchedule",
    description: "Schedule ↔ EnrichedSchedule (every schedule response is actor-enriched)",
  },
  // --- Package domain ---
  { specSchemaName: "AgentDetail", sharedTypeName: "AgentDetail", description: "AgentDetail" },
  {
    specSchemaName: "AgentListItem",
    sharedTypeName: "AgentListItem",
    description: "AgentListItem",
  },
  {
    specSchemaName: "OrgPackageItem",
    sharedTypeName: "OrgPackageItem",
    description: "OrgPackageItem",
  },
  {
    specSchemaName: "OrgPackageItemDetail",
    sharedTypeName: "OrgPackageItemDetail",
    description: "OrgPackageItemDetail",
  },
  {
    specSchemaName: "AgentVersion",
    sharedTypeName: "VersionListItem",
    description: "AgentVersion ↔ VersionListItem",
  },
  {
    specSchemaName: "PackageVersionDetail",
    sharedTypeName: "VersionDetailResponse",
    description: "PackageVersionDetail ↔ VersionDetailResponse",
  },
  // --- Org resources ---
  {
    specSchemaName: "OrgProxy",
    sharedTypeName: "OrgProxyInfo",
    description: "OrgProxy ↔ OrgProxyInfo",
  },
  {
    specSchemaName: "OrgModel",
    sharedTypeName: "OrgModelInfo",
    description: "OrgModel ↔ OrgModelInfo",
  },
  {
    specSchemaName: "ModelProviderCredential",
    sharedTypeName: "ModelProviderCredentialInfo",
    description: "ModelProviderCredential ↔ ModelProviderCredentialInfo",
  },
  { specSchemaName: "ApiKeyInfo", sharedTypeName: "ApiKeyInfo", description: "ApiKeyInfo" },
  {
    specSchemaName: "ApplicationObject",
    sharedTypeName: "ApplicationInfo",
    description: "ApplicationObject ↔ ApplicationInfo",
  },
  {
    specSchemaName: "ApplicationPackage",
    sharedTypeName: "InstalledPackage",
    description: "ApplicationPackage ↔ InstalledPackage",
  },
  {
    specSchemaName: "IntegrationPin",
    sharedTypeName: "IntegrationPin",
    description: "IntegrationPin",
  },
  // Inline oauth-client response (create 201 / rotate 200) — both return the
  // secret-stripped public client via `toPublicClient`. Registered so the
  // shared-type's `id` (+ the rest) can't drift back out of the spec.
  {
    path: "/api/integrations/{packageId}/auths/{authKey}/oauth-clients",
    method: "post",
    status: "201",
    sharedTypeName: "IntegrationOAuthClient",
    description: "POST .../oauth-clients 201 ↔ IntegrationOAuthClient",
  },
  {
    path: "/api/integrations/{packageId}/oauth-clients/{clientId}",
    method: "put",
    status: "200",
    sharedTypeName: "IntegrationOAuthClient",
    description: "PUT .../oauth-clients/{clientId} 200 ↔ IntegrationOAuthClient",
  },
  // Inline connection response (import-connection 200) — the PR added `client_ref`
  // to both the schema and the type; register so they stay locked together.
  {
    path: "/api/integrations/{packageId}/auths/{authKey}/connect/fields",
    method: "post",
    status: "200",
    sharedTypeName: "IntegrationConnection",
    description: "POST .../connect/fields (import) 200 ↔ IntegrationConnection",
  },
  { specSchemaName: "TestResult", sharedTypeName: "TestResult", description: "TestResult" },
  // --- Organization ---
  {
    specSchemaName: "Organization",
    sharedTypeName: "OrganizationWithRole",
    description: "Organization ↔ OrganizationWithRole",
  },
  {
    specSchemaName: "OrgInvitationInfo",
    sharedTypeName: "OrgInvitation",
    description: "OrgInvitationInfo ↔ OrgInvitation",
  },
  {
    specSchemaName: "OrgMember",
    sharedTypeName: "OrganizationMember",
    description: "OrgMember ↔ OrganizationMember",
  },
  { specSchemaName: "OrgSettings", sharedTypeName: "OrgSettings", description: "OrgSettings" },
  // --- Module wire shapes (faithful shared-type twins; already aligned) ---
  {
    specSchemaName: "WebhookObject",
    sharedTypeName: "WebhookInfo",
    description: "WebhookObject ↔ WebhookInfo",
  },
  {
    specSchemaName: "SmtpConfigView",
    sharedTypeName: "SmtpConfigView",
    description: "SmtpConfigView",
  },
  {
    specSchemaName: "SocialProviderView",
    sharedTypeName: "SocialProviderView",
    description: "SocialProviderView",
  },
];

/**
 * Component schemas that have NO `@appstrate/shared-types` consumer and are
 * therefore not subject to the step-7 required-field comparison. The coverage
 * check in verify-openapi fails if a component schema is neither registered
 * above nor listed here — so a new response schema can't silently escape the
 * gate. Each entry carries the reason it has no shared-type twin.
 */
export const EXEMPT_SCHEMAS: Record<string, string> = {
  // AFPS manifest schemas — the spec mirrors the AFPS standard (AJV-validated
  // at runtime), no hand-written shared-type.
  AgentManifest: "AFPS manifest standard; validated by AJV, not a shared-type",
  AgentSkillRef: "AFPS dependency sub-object embedded in AgentDetail.dependencies",
  FileConstraintsMap: "AFPS schema-wrapper sub-schema (structural map)",
  UIHintsMap: "AFPS schema-wrapper sub-schema (structural map)",
  // Error + auth/credential wire with no SPA shared-type consumer.
  ProblemDetail: "RFC 9457 error envelope; never read through a shared-type",
  ResolutionFieldError: "ProblemDetail.errors[] item; never read through a shared-type",
  AgentConnectionReadiness:
    "bulk agent connection-readiness envelope; SPA uses the generated spec type (integrations[].resolution is the registered IntegrationAgentResolution)",
  OAuthClientObject: "OIDC oauth-admin wire; no shared-type (SPA uses the generated spec type)",
  OAuthClientWithSecret: "OIDC client-create wire; no shared-type",
  OAuthTokenResponse: "internal credential-proxy wire; mirrors @appstrate/core/sidecar-types",
  IntegrationCredentialsResponse: "sidecar↔platform credential-proxy wire; no SPA consumer",
  DesktopCommandRequest: "desktop-bridge command envelope; JSON-RPC-ish wire, no SPA consumer",
  DesktopAgentCommandRequest:
    "desktop-bridge agent-path command envelope (adds credential substitution); no SPA consumer",
  DesktopCommandResponse:
    "desktop-bridge reply forwarded verbatim from the Electron client; `result` is method-specific, no shared-type",
  DesktopStatusResponse: "desktop-bridge liveness probe; single boolean, no shared-type",
  User: "Better-Auth-shaped minimal user; no shared-type",
  ProfileBatchItem: "profiles/batch list item; SPA uses the generated spec type",
  LibraryPackageList: "SPA consumes components['schemas']['LibraryPackageList'] directly",
  OrgDetail: "composite org-detail response (members+invitations+settings); no single shared-type",
  // Drizzle-derived types whose shared-type shape intentionally diverges from
  // the wire (Date vs ISO string / joined-resource shape) — the SPA consumes
  // the generated spec type, not the shared-type.
  UserProfile:
    "shared-type is the Drizzle profiles row (Date, displayName); wire is the joined {id,language,email,name} resource",
  RunLog:
    "shared-type RunLog has createdAt:Date; wire is an ISO string — SPA consumes the generated spec type",
  // @appstrate/module-chat wire DTOs. The module owns no tables of its own as a
  // shared-type export (chat_sessions/chat_messages are core schema), and these
  // are hand-shaped wire envelopes (ISO timestamps, opaque message content) the
  // chat UI consumes via the generated spec type — not a Drizzle shared-type.
  ChatSession:
    "module-chat wire DTO; ISO timestamps, no shared-type (UI uses the generated spec type)",
  ChatMessage: "module-chat opaque history-node wire DTO; no shared-type",
};

/**
 * Accepted spec-optional-but-type-required fields, keyed by `specSchemaName`
 * or inline `path`. Each listed field is a deliberate, reviewed exception:
 * the shared-type marks it required but the spec intentionally leaves it
 * optional. Keep every entry justified with a comment.
 */
export const KNOWN_DRIFT: Record<string, string[]> = {
  // OrganizationMember requires `orgId`, but the OrgMember response schema does
  // not echo it per-member — org scope is implied by the parent OrgDetail
  // resource / the route's :orgId path param.
  OrgMember: ["orgId"],
};
