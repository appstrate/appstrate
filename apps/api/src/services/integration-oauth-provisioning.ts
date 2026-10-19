// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth client provisioning at connect time: the authorization server of an auth, its validated
 * metadata, and the client presented to it — this instance's Client ID Metadata Document, a client
 * registered by RFC 7591 Dynamic Client Registration, or the registered clients of a classic auth.
 */

import { and, eq, isNotNull, lt, notExists, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationOauthClients } from "@appstrate/db/schema";
import {
  resolveOAuthEndpoints,
  discoverProtectedResourceMetadata,
  registerDynamicClient,
  DynamicClientRegistrationError,
  OAUTH_STATE_TTL_SECONDS,
  sameUrlIdentifier,
  withOfflineAccess,
} from "@appstrate/connect";
import {
  isVariableTemplate,
  renderUrlTemplate,
  variableRefs,
} from "@appstrate/afps-shared/connection-variables";
import { acquiresByConnectLogin, type IntegrationManifest } from "@appstrate/core/integration";
import { egressFetchImpl, isBlockedEgressUrl } from "../lib/egress-host-guard.ts";
import {
  clientMetadataDocumentUrl,
  presentsClientMetadataDocument,
  platformClientName,
  provisionabilityProblems,
  type ProvisionabilityProblem,
} from "../lib/integration-client-metadata.ts";
import { isUniqueViolation } from "../lib/db-helpers.ts";
import { logger } from "../lib/logger.ts";
import { ApiError, invalidRequest, forbidden, validationFailed } from "../lib/errors.ts";
import type { OrgScope, SpaceScope } from "../lib/scope.ts";
import {
  clientMetadataCallbackUrlFor,
  clientMetadataRedirectTag,
  authorizationServerTag,
  integrationCallbackUrlFor,
} from "../lib/integration-callback-url.ts";
import { normalizeOAuthErrorCode, oauthDiagnosticSuffix } from "../lib/oauth-error-diagnostic.ts";
import { isSystemPackage } from "./system-packages.ts";
import { isUserUrlReachable, type ConnectionVariables } from "./connect/connection-variables.ts";
import {
  getRemoteSource,
  hasPerConnectionAuthServer,
  renderRemoteSource,
  toSupportedTokenEndpointAuthMethod,
  usesAutoProvisionedClient,
  type AfpsManifestAuth,
} from "./integration-manifest-helpers.ts";
import {
  createIntegrationOAuthClient,
  getAutoProvisionedClient,
  loadClientTiers,
  tierAuthFilter,
  type IntegrationOAuthClientWithSecret,
  type ResolvedConnectClient,
  type ResolvedOAuthConnect,
} from "./integration-connections.ts";

type ServerMetadata = Awaited<ReturnType<typeof resolveOAuthEndpoints>>;

/** Discovery and DCR URLs are manifest-, user- (AFPS §8.7) and server-derived: every hop guarded. */
const ssrfGuardedFetch = egressFetchImpl();
/** The DCR POST is never redirected (a 3xx bounces the registration). */
const dcrGuardedFetch = egressFetchImpl({ maxRedirects: 0 });

/** Drop a URL that targets a blocked (loopback/RFC1918/link-local/metadata) host. */
function safeUrl(url: string | undefined): string | undefined {
  return url && !isBlockedEgressUrl(url) ? url : undefined;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * No client could be provisioned for an auto-provisioned auth. `reason` is authored by the failing
 * step, remedy included; `status` is the authorization server's when it answered.
 */
function provisioningFailed(packageId: string, authKey: string, reason: string, status?: number) {
  return forbidden(
    `Could not automatically provision an OAuth client for '${packageId}' auth '${authKey}'${status ? ` (HTTP ${status})` : ""}: ${reason}`,
  );
}

/** An authorization server that did not answer: retryable, unlike a refusal of its metadata. */
function authorizationServerUnreachable(packageId: string, authKey: string, reason: string) {
  return new ApiError({
    status: 503,
    code: "authorization_server_unreachable",
    title: "Authorization Server Unreachable",
    detail: `The authorization server of '${packageId}' auth '${authKey}' could not be reached: ${reason}`,
  });
}

/** The 403 refusing a server that lacks `problem` ({@link provisionabilityProblems}). */
function unprovisionableServer(
  problem: ProvisionabilityProblem,
  packageId: string,
  authKey: string,
  issuer: string,
): ApiError {
  const server = `The authorization server ${issuer} of '${packageId}' auth '${authKey}'`;
  return problem === "authorization_server_pkce_unsupported"
    ? new ApiError({
        status: 403,
        code: problem,
        title: "Authorization Server Without PKCE",
        detail: `${server} does not advertise PKCE S256 in its metadata (code_challenge_methods_supported), which an MCP connection requires.`,
      })
    : new ApiError({
        status: 403,
        code: problem,
        title: "Authorization Server Without Issuer Identification",
        detail: `${server} does not advertise RFC 9207 issuer identification (authorization_response_iss_parameter_supported), which a client this platform provisions for an integration other than a system one requires.`,
      });
}

/**
 * Refuse, before any client is provisioned, a server that misses an advertisement
 * {@link provisionabilityProblems} requires; `vouched` is a system integration's own fixed server.
 */
function assertProvisionableServer(
  packageId: string,
  authKey: string,
  auth: AfpsManifestAuth,
  metadata: {
    issuer: string;
    codeChallengeMethodsSupported?: string[];
    authorizationResponseIssParameterSupported?: boolean;
  },
  policy: { mcp: boolean; vouched: boolean },
): void {
  if (acquiresByConnectLogin(auth)) return;
  const [problem] = provisionabilityProblems(metadata, policy);
  if (problem) throw unprovisionableServer(problem, packageId, authKey, metadata.issuer);
}

/**
 * The metadata of the declared issuer of a remote source's pre-registered client: AFPS §7.3 client
 * binding (no contradicted endpoint) and MCP PKCE S256 — no `iss`, which binds provisioned clients
 * only. None for a `connect.login` auth, which runs no authorization request.
 */
async function preRegisteredServerMetadata(
  packageId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
): Promise<ResolvedOAuthConnect["serverMetadata"]> {
  if (!auth.issuer || getRemoteSource(manifest) === null || acquiresByConnectLogin(auth)) {
    return undefined;
  }
  const metadata = await resolveOAuthEndpoints({ issuer: auth.issuer });
  assertEndpointsMatchMetadata(packageId, authKey, auth, metadata);
  if (metadata.issuer !== undefined) {
    const [problem] = provisionabilityProblems(metadata, { mcp: true, vouched: true });
    if (problem) throw unprovisionableServer(problem, packageId, authKey, metadata.issuer);
  }
  return metadata;
}

/**
 * AFPS §7.3 *Client binding*: refuse a manifest-declared endpoint that the validated metadata of
 * the auth's authorization server contradicts — its client is presented to that server only.
 */
export function assertEndpointsMatchMetadata(
  packageId: string,
  authKey: string,
  auth: Pick<AfpsManifestAuth, "authorization_endpoint" | "token_endpoint">,
  metadata: { issuer?: string; authorizationEndpoint?: string; tokenEndpoint?: string },
): void {
  if (metadata.issuer === undefined) return;
  const contradicted = (
    [
      ["authorization_endpoint", auth.authorization_endpoint, metadata.authorizationEndpoint],
      ["token_endpoint", auth.token_endpoint, metadata.tokenEndpoint],
    ] as const
  ).find(
    ([, declared, validated]) =>
      declared !== undefined && validated !== undefined && declared !== validated,
  )?.[0];
  if (contradicted) {
    throw invalidRequest(
      `Integration '${packageId}' auth '${authKey}' declares a ${contradicted} that the metadata of its authorization server (${metadata.issuer}) contradicts; its OAuth client is presented only to that server's own endpoints.`,
    );
  }
}

/**
 * This instance's Client ID Metadata Document of `issuer`'s server as the connect-time client: no
 * row, the document URL is both `client_id` and `client_ref`, and the redirect URI is the server's
 * own in the documents' namespace (`<callback>/cimd/<tag>`) — never the shared callback, nor the
 * one a DCR client of the same server registers.
 */
function metadataDocumentClient(issuer: string): ResolvedConnectClient {
  const url = clientMetadataDocumentUrl(issuer);
  return {
    clientId: url,
    redirectUri: clientMetadataCallbackUrlFor(issuer),
    redirectTag: clientMetadataRedirectTag(authorizationServerTag(issuer)),
    clientRef: url,
  };
}

/**
 * Resolve the OAuth connect config for an auth. A remote MCP auto-provisioned auth gets its client
 * in the MCP 2026-07-28 order: this instance's Client ID Metadata Document when the server accepts
 * one and the instance can serve it, else RFC 7591 Dynamic Client Registration, its server found by
 * `source.remote.url` → RFC 9728 → RFC 8414; a server chosen per connection (AFPS §7.3) goes to
 * {@link ensurePerConnectionOAuthClient}. Throws when no client can be provisioned. A classic auth
 * gets its registered clients, and the checked metadata of a remote source's declared issuer.
 */
export async function ensureIntegrationOAuthClient(
  scope: SpaceScope,
  packageId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  variables: ConnectionVariables = {},
): Promise<ResolvedOAuthConnect> {
  if (hasPerConnectionAuthServer(manifest, auth)) {
    return ensurePerConnectionOAuthClient(scope, packageId, authKey, manifest, auth, variables);
  }
  // Classic: every space and org client (the connect resolver picks the default); the caller
  // takes the endpoints from the manifest.
  if (!usesAutoProvisionedClient(manifest, auth)) {
    const { space, org } = await loadClientTiers(scope, packageId, authKey);
    const serverMetadata = await preRegisteredServerMetadata(packageId, authKey, manifest, auth);
    return { spaceClients: space, orgClients: org, ...(serverMetadata ? { serverMetadata } : {}) };
  }

  // RFC 9728 metadata is authoritative for the `resource` (the token's audience: a mismatch makes
  // the token unusable against the MCP server); the manifest may pin the issuer. Best-effort.
  let issuer = auth.issuer;
  let resource = auth.resource;
  const remote = getRemoteSource(manifest);
  if (remote?.url) {
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: remote.url,
      fetchImpl: ssrfGuardedFetch,
    });
    if (md) {
      issuer = issuer ?? md.authorizationServers[0];
      resource = md.resource ?? resource;
    }
  }

  // SSRF: a server-advertised issuer could steer RFC 8414 discovery (fetched on the issuer host)
  // at internal infra; a blocked one degrades to "no discovery".
  if (issuer && isBlockedEgressUrl(issuer)) {
    logger.warn("auto-DCR: discovered issuer blocked by SSRF guard", {
      packageId,
      authKey,
      issuer,
    });
    issuer = undefined;
  }

  // AFPS §7.3: the issuer's validated metadata wins; a manifest endpoint stands in only without it.
  const discovered = issuer ? await resolveOAuthEndpoints({ issuer }) : {};
  assertEndpointsMatchMetadata(packageId, authKey, auth, discovered);
  if (discovered.issuer !== undefined) {
    assertProvisionableServer(
      packageId,
      authKey,
      auth,
      { ...discovered, issuer: discovered.issuer },
      { mcp: remote !== null, vouched: isSystemPackage(packageId) },
    );
  }
  const authorizationEndpoint = discovered.authorizationEndpoint ?? auth.authorization_endpoint;
  const tokenEndpoint = discovered.tokenEndpoint ?? auth.token_endpoint;

  // RFC 9700 §4.4.2: a DCR client is bound to, and called back for, one validated server (a
  // metadata document, presentable only with a validated issuer, never reaches these throws).
  if (discovered.metadataUnreachable) {
    throw authorizationServerUnreachable(
      packageId,
      authKey,
      "its metadata (RFC 8414) did not answer; retry shortly",
    );
  }
  if (discovered.issuer === undefined) {
    throw provisioningFailed(
      packageId,
      authKey,
      "the authorization server publishes no valid metadata (RFC 8414), so no client can be registered for it; register an OAuth client manually, or retry once it does",
    );
  }

  // SSRF: the token endpoint is fetched server-side at exchange — a blocked one is dropped.
  return provisionClient(
    scope,
    packageId,
    authKey,
    auth,
    { ...discovered, issuer: discovered.issuer },
    {
      ...(issuer ? { issuer } : {}),
      ...(safeUrl(authorizationEndpoint) ? { authorizationEndpoint } : {}),
      ...(safeUrl(tokenEndpoint) ? { tokenEndpoint } : {}),
      ...(resource ? { resource } : {}),
      serverMetadata: discovered,
    },
    false,
  );
}

/**
 * The OAuth connect config of an auth whose authorization server is chosen per connection (AFPS
 * §7.3). Every URL here is rendered from the user's variables or learned from a response to one,
 * so it is egress-checked, never trusted as author-declared (§8.6, §8.7):
 *
 *   - remote source: RFC 9728 metadata of the rendered URL; the advertised server must equal the
 *     rendered `issuer`, else share the URL's origin — never another provider's server. Its
 *     `resource` is sent (RFC 8707).
 *   - otherwise the rendered `issuer`, no resource.
 *   - endpoints from that server's RFC 8414 metadata only; a redirect URI per issuer
 *     (`<callback>/<tag>`), carried by the issuer's own metadata document (CIMD) when the server
 *     accepts one and this instance can serve it, else by a public DCR client per issuer.
 *
 * A failure the user's choice explains is a 400 on the variable that chose it.
 */
async function ensurePerConnectionOAuthClient(
  scope: SpaceScope,
  packageId: string,
  authKey: string,
  manifest: IntegrationManifest,
  auth: AfpsManifestAuth,
  variables: ConnectionVariables,
): Promise<ResolvedOAuthConnect> {
  if (auth.token_endpoint_auth_method !== "none") {
    throw invalidRequest(
      `Integration '${packageId}' auth '${authKey}' chooses its authorization server per connection, so its OAuth client is provisioned automatically as a public client (client metadata document or RFC 7591 registration): the auth must declare token_endpoint_auth_method 'none'.`,
    );
  }
  const remoteTemplate = getRemoteSource(manifest)?.url;
  // The template the user's server is chosen by: the remote URL when it is one, else the issuer.
  const chooser = isVariableTemplate(remoteTemplate) ? remoteTemplate : auth.issuer!;
  const refuse = (code: string, message: string): ApiError => {
    const [name] = variableRefs(chooser);
    return validationFailed([
      { field: `variables.${name}`, code, title: "Invalid Connection Variable", message },
    ]);
  };
  // Both render: the caller's `resolveConnectionVariables` refused any value that would not.
  const remote = renderRemoteSource(manifest, variables);
  const declaredIssuer =
    auth.issuer === undefined ? undefined : renderUrlTemplate(auth.issuer, variables)!;

  let candidate: string;
  let resource: string | undefined;
  if (remote) {
    const md = await discoverProtectedResourceMetadata({
      resourceServerUrl: remote.url,
      fetchImpl: ssrfGuardedFetch,
    });
    if (!md) {
      throw refuse(
        "authorization_server_unavailable",
        `the server at ${remote.url} publishes no OAuth protected-resource metadata for it (RFC 9728)`,
      );
    }
    const named = md.authorizationServers.find((advertised) =>
      declaredIssuer === undefined
        ? sameOrigin(advertised, remote.url)
        : sameUrlIdentifier(advertised, declaredIssuer),
    );
    if (named === undefined) {
      throw refuse(
        "authorization_server_mismatch",
        `the server at ${remote.url} names no authorization server ${
          declaredIssuer === undefined
            ? `on ${new URL(remote.url).origin}`
            : `equal to ${declaredIssuer}`
        } (it names ${md.authorizationServers.join(", ")})`,
      );
    }
    candidate = named;
    resource = md.resource;
  } else {
    candidate = declaredIssuer!;
  }

  if (!(await isUserUrlReachable(candidate))) {
    throw refuse(
      "egress_blocked",
      `names the authorization server ${candidate}, which this platform does not reach`,
    );
  }
  const endpoints = await resolveOAuthEndpoints({ issuer: candidate });
  if (endpoints.metadataUnreachable) {
    throw authorizationServerUnreachable(
      packageId,
      authKey,
      `${candidate}'s metadata (RFC 8414) did not answer; retry shortly`,
    );
  }
  if (!endpoints.issuer || !endpoints.authorizationEndpoint || !endpoints.tokenEndpoint) {
    throw refuse(
      "authorization_server_unavailable",
      `the authorization server ${candidate} publishes no valid metadata (RFC 8414)`,
    );
  }
  const issuer = endpoints.issuer;
  assertProvisionableServer(
    packageId,
    authKey,
    auth,
    { ...endpoints, issuer },
    { mcp: remote !== null, vouched: false },
  );
  for (const url of [
    endpoints.authorizationEndpoint,
    endpoints.tokenEndpoint,
    // Reached only to register by DCR.
    ...(endpoints.registrationEndpoint && !presentsClientMetadataDocument(endpoints)
      ? [endpoints.registrationEndpoint]
      : []),
  ]) {
    if (!(await isUserUrlReachable(url))) {
      throw refuse(
        "egress_blocked",
        `the authorization server ${candidate} advertises the endpoint ${url}, which this platform does not reach`,
      );
    }
  }

  return provisionClient(
    scope,
    packageId,
    authKey,
    auth,
    { ...endpoints, issuer },
    {
      issuer,
      authorizationEndpoint: endpoints.authorizationEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
      ...(resource ? { resource } : {}),
      ...(remote ? { serverMetadata: endpoints } : {}),
    },
    true,
  );
}

/**
 * The client of the validated server `metadata` names, bound to its issuer: this instance's
 * metadata document when the server accepts one — ahead of any DCR client registered before, whose
 * connections keep it (their `client_ref`) — else the auth's DCR client of that issuer, registered
 * when there is none. A reuse of a per-connection server's client renews its lease against
 * {@link pruneUnusedPerConnectionClients}.
 */
async function provisionClient(
  scope: SpaceScope,
  packageId: string,
  authKey: string,
  auth: AfpsManifestAuth,
  metadata: ServerMetadata & { issuer: string },
  connect: Omit<ResolvedOAuthConnect, "spaceClients" | "orgClients" | "authorizationServer">,
  chosenPerConnection: boolean,
): Promise<ResolvedOAuthConnect> {
  const { issuer } = metadata;
  const resolved: ResolvedOAuthConnect = {
    spaceClients: [],
    orgClients: [],
    ...connect,
    authorizationServer: {
      issuer,
      issParameterSupported: metadata.authorizationResponseIssParameterSupported === true,
    },
  };
  if (presentsClientMetadataDocument(metadata)) {
    return { ...resolved, metadataDocumentClient: metadataDocumentClient(issuer) };
  }
  const existing = await getAutoProvisionedClient(scope, packageId, authKey, issuer);
  if (existing) {
    if (chosenPerConnection) {
      await db
        .update(integrationOauthClients)
        .set({ updatedAt: new Date() })
        .where(eq(integrationOauthClients.id, existing.id));
    }
    return { ...resolved, orgClients: [existing] };
  }
  if (chosenPerConnection) await pruneUnusedPerConnectionClients(scope, packageId, authKey);
  return registerAutoProvisionedClient(
    { orgId: scope.orgId },
    packageId,
    authKey,
    auth,
    metadata,
    chosenPerConnection,
    resolved,
  );
}

/**
 * Delete the org's per-connection-server clients of this auth that minted no connection: whoever
 * opens a connect flow chooses the server. One used within an OAuth state's lifetime may await it.
 */
async function pruneUnusedPerConnectionClients(
  org: OrgScope,
  packageId: string,
  authKey: string,
): Promise<void> {
  await db.delete(integrationOauthClients).where(
    and(
      tierAuthFilter({ orgId: org.orgId }, packageId, authKey),
      eq(integrationOauthClients.autoProvisioned, true),
      isNotNull(integrationOauthClients.issuer),
      lt(integrationOauthClients.updatedAt, new Date(Date.now() - OAUTH_STATE_TTL_SECONDS * 1000)),
      notExists(
        db
          .select({ id: integrationConnections.id })
          .from(integrationConnections)
          .where(eq(integrationConnections.clientRef, sql`${integrationOauthClients.id}::text`)),
      ),
    ),
  );
}

/**
 * Register a public client (RFC 7591) as the auth's auto-provisioned client of `metadata.issuer`,
 * on that server's own redirect URI; a failure is {@link provisioningFailed}, its reason naming the
 * remedy. A server that revokes the client later (RFC 7591 §3.2) fails connect and refresh with
 * `invalid_client` until an admin deletes the stored client: nothing re-registers automatically.
 */
async function registerAutoProvisionedClient(
  org: OrgScope,
  packageId: string,
  authKey: string,
  auth: AfpsManifestAuth,
  metadata: ServerMetadata & { issuer: string },
  chosenPerConnection: boolean,
  resolved: ResolvedOAuthConnect,
): Promise<ResolvedOAuthConnect> {
  const { registrationEndpoint, issuer } = metadata;
  const redirectUri = integrationCallbackUrlFor(issuer);
  // A server chosen per connection takes no manual client: the remedy is on its side.
  const manualRemedy = chosenPerConnection
    ? "a server chosen per connection must support it"
    : "register an OAuth client manually for this integration";

  if (!registrationEndpoint) {
    logger.warn("auto-DCR: no registration_endpoint discovered", {
      packageId,
      authKey,
      issuer: resolved.issuer,
    });
    const server = `the authorization server ${issuer}`;
    // Advertised, but no document presented (`presentsClientMetadataDocument`): the failure says so.
    const message =
      metadata.clientIdMetadataDocumentSupported === true
        ? `${server} accepts client metadata documents but not dynamic client registration, and this instance presents no document: it takes a server that also advertises RFC 9207 iss (authorization_response_iss_parameter_supported), a public https APP_URL the server can fetch, and INTEGRATION_OAUTH_CIMD not set to 'off'; ${
            chosenPerConnection
              ? "meet those conditions to connect to it"
              : "register an OAuth client manually, or meet those conditions"
          }`
        : chosenPerConnection
          ? `${server} advertises neither client metadata documents nor dynamic client registration (RFC 7591), one of which a server chosen per connection requires`
          : `${server} advertises neither client metadata documents nor dynamic client registration; register an OAuth client manually, or retry once the server advertises one of them`;
    throw provisioningFailed(packageId, authKey, message);
  }

  // A literal pre-check (no DNS) for a friendly refusal of an obviously-internal target; the
  // authoritative guard is the DCR transport itself, `dcrGuardedFetch` (per-hop DNS, no redirect).
  if (isBlockedEgressUrl(registrationEndpoint)) {
    logger.warn("auto-DCR: registration_endpoint blocked by SSRF guard", {
      packageId,
      authKey,
      registrationEndpoint,
    });
    throw provisioningFailed(
      packageId,
      authKey,
      `the discovered registration endpoint was refused as an unsafe (loopback/internal) target; ${manualRemedy}`,
    );
  }

  // Narrow the window of a parallel Connect registering for the same (org, package, auth, issuer).
  const racedClient = await getAutoProvisionedClient(org, packageId, authKey, issuer);
  if (racedClient) return { ...resolved, orgClients: [racedClient] };

  try {
    const dcrAuthMethod = toSupportedTokenEndpointAuthMethod(auth.token_endpoint_auth_method);
    // The `refresh_token` grant only when advertised (RFC 8414 `grant_types_supported`): a server
    // without it (e.g. ClickUp MCP) may reject a registration that requests it.
    const grantTypes = metadata.grantTypesSupported?.includes("refresh_token")
      ? ["authorization_code", "refresh_token"]
      : ["authorization_code"];
    const scopes = withOfflineAccess(auth.default_scopes ?? [], metadata.scopesSupported);
    const registration = await registerDynamicClient({
      registrationEndpoint,
      redirectUri,
      clientName: platformClientName(),
      grantTypes,
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(dcrAuthMethod ? { tokenEndpointAuthMethod: dcrAuthMethod } : {}),
      fetchImpl: dcrGuardedFetch,
    });
    // RFC 7591 §3.2.1: the response states what the server registered, which may differ from the
    // public client asked for. Refused here, before anything is stored: persisted, a secret beside
    // the manifest's "none" would fail only at the callback (`assertClientAuthCoherent`), after
    // consent, on a row no admin can repair. The upstream registration is abandoned unused.
    const registeredMethod = registration.tokenEndpointAuthMethod;
    const declaresSecretMethod = registeredMethod !== undefined && registeredMethod !== "none";
    if (declaresSecretMethod || registration.clientSecret !== undefined) {
      logger.warn("auto-DCR: authorization server registered a confidential client", {
        packageId,
        authKey,
        registrationEndpoint,
        clientId: registration.clientId,
        tokenEndpointAuthMethod: registeredMethod,
        returnedClientSecret: registration.clientSecret !== undefined,
      });
      // Server-controlled: named only through the OAuth error-code shape guard.
      const method = normalizeOAuthErrorCode(registeredMethod);
      const did = declaresSecretMethod
        ? `registered a confidential client${method ? ` (token_endpoint_auth_method='${method}')` : ""}`
        : "returned a client_secret";
      throw provisioningFailed(
        packageId,
        authKey,
        `the authorization server ${did} although Appstrate requested a public client ` +
          `(token_endpoint_auth_method='none' + PKCE — the only shape automatic registration drives); ` +
          manualRemedy,
      );
    }
    let client: IntegrationOAuthClientWithSecret;
    try {
      client = await createIntegrationOAuthClient(
        org,
        packageId,
        authKey,
        {
          clientId: registration.clientId,
          clientSecret: "",
          tokenEndpointAuthMethod: "none",
          redirectUri,
        },
        { autoProvisioned: true, issuer },
      );
    } catch (insertErr) {
      // A parallel Connect won the race past `racedClient`: `idx_ioc_one_auto` refuses the second
      // row (23505), and the connection proceeds on the winner's client.
      if (isUniqueViolation(insertErr)) {
        const winner = await getAutoProvisionedClient(org, packageId, authKey, issuer);
        if (winner) {
          logger.info("auto-DCR: lost registration race, reusing concurrently-registered client", {
            packageId,
            authKey,
            clientId: winner.client_id,
          });
          return { ...resolved, orgClients: [winner] };
        }
      }
      throw insertErr;
    }
    logger.info("auto-DCR: registered OAuth client", {
      packageId,
      authKey,
      clientId: registration.clientId,
      ...(issuer ? { issuer } : {}),
    });
    return { ...resolved, orgClients: [client] };
  } catch (err) {
    if (err instanceof DynamicClientRegistrationError) {
      logger.warn("auto-DCR: dynamic client registration failed", {
        packageId,
        authKey,
        registrationEndpoint,
        status: err.status,
        oauthError: err.errorCode,
        err: err.message,
      });
      // No response: a retry is the remedy.
      if (err.status === undefined) {
        throw provisioningFailed(
          packageId,
          authKey,
          "could not reach the authorization server to register a client; retry once it is reachable",
        );
      }
      // A refusal: the server's own `error_description` (never the raw body, which stays in the log)
      // and its RFC 6749 §5.2 `error` code, the description being optional.
      const codeSuffix = oauthDiagnosticSuffix(err.errorCode, undefined);
      throw provisioningFailed(
        packageId,
        authKey,
        `${err.errorDescription ?? "the authorization server rejected dynamic client registration"}${codeSuffix}`,
        err.status,
      );
    }
    throw err;
  }
}
