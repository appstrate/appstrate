// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugins contributed by the OIDC module.
 *
 * Wires the `@better-auth/oauth-provider` plugin onto the platform Better
 * Auth singleton so Appstrate acts as an OAuth 2.1 / OIDC authorization
 * server. The flow is **polymorphic** — the same plugin handles two distinct
 * client scoping levels, discriminated by `oauth_clients.level`:
 *
 *   1. **Org-level** (`level: "org"`): dashboard users (org operators) scoped
 *      to a single organization pinned at client creation. Tokens carry
 *      `actor_type: "dashboard_user"` + `org_id` + `org_role`.
 *   2. **Space-level** (`level: "space"`): space end-users
 *      scoped to a single space. Tokens carry `actor_type: "end_user"`
 *      + `space_id` + `end_user_id`.
 *
 * The claim builder reaches that level through the `oauth_clients` ROW, and is
 * registered as a provider claim extension for exactly that reason: an
 * extension receives the resolved client, while `customAccessTokenClaims`
 * receives only the provider-owned `metadata` JSON, which a registration body
 * may set. All claim names are RFC 9068 / OIDC Core snake_case.
 *
 * `jwt()` is listed explicitly below: `getJwtPlugin` throws
 * `BetterAuthError("jwt_config")` when oauth-provider mints a JWT access token
 * and no JWT plugin is installed. The JWKS is served at `/api/auth/jwks`, OIDC
 * discovery at `/api/auth/.well-known/openid-configuration`, and the token /
 * authorize / userinfo / revoke / introspect endpoints at `/api/auth/oauth2/*`.
 *
 * Client secret storage matches the `oauth-admin` service hash (SHA-256 hex).
 */

import { randomInt, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { oauthProvider, type OAuthOptions, type Scope } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { bearer, jwt } from "better-auth/plugins";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { APIError } from "better-auth/api";
import { getEnv } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { oauthClient } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";
import { getOrgSettings } from "../../../services/organizations.ts";
import {
  resolveOrCreateEndUser,
  UnverifiedEmailConflictError,
  SpaceSignupClosedError,
  loadSpaceById,
} from "../services/enduser-mapping.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { isBlockedUrl } from "@appstrate/core/ssrf";
import {
  OrgSignupClosedError,
  OrgSignupConfigurationError,
  loadClientSignupPolicy,
  resolveOrCreateOrgMembership,
} from "../services/orgmember-mapping.ts";
import {
  hashSecret,
  getClientCached,
  markClientSelfService,
  type OAuthClientRecord,
} from "../services/oauth-admin.ts";
import { socialOverridePlugin } from "../services/ba-social-override-plugin.ts";
import { oidcGuardsPlugin } from "./guards.ts";
import { cliTokenPlugin } from "./cli-plugin.ts";
import { assertUserRealm } from "./realm-check.ts";
import { getAppstrateScopes, getSelfServiceScopes } from "./scopes.ts";

const SHA256_HEX_LENGTH = 64;

/**
 * Constant-time comparison of the SHA-256 hex digest of `clientSecret`
 * against the stored hash. Uses `crypto.timingSafeEqual` on raw buffers
 * so the comparison cost does not depend on the position of the first
 * byte mismatch (prevents timing side channels on secret verification).
 *
 * `timingSafeEqual` requires equal-length buffers — we early-return on
 * length mismatch, which is safe because the stored hash length is a
 * public constant (64 hex chars) and does not leak secret material.
 *
 * Exported for unit testing — not part of the module's public surface.
 */
export async function sha256HexVerify(clientSecret: string, storedHash: string): Promise<boolean> {
  const computed = await hashSecret(clientSecret);
  // Invariant: hashSecret() produces SHA-256 hex (64 chars) and stored
  // hashes were written by the same function. A length mismatch here
  // means either the hash algorithm was changed without re-hashing
  // existing rows (migration bug) or storedHash is corrupt/truncated —
  // both are states that must not silently deny-all. Fail loud so the
  // operator sees the incident.
  if (computed.length !== SHA256_HEX_LENGTH) {
    logger.error("oidc: hashSecret() returned unexpected length — possible algorithm drift", {
      module: "oidc",
      audit: true,
      event: "oauth.client_secret.hash_length_drift",
      expected: SHA256_HEX_LENGTH,
      actual: computed.length,
    });
    throw new Error("OAuth client secret verification is misconfigured — contact the operator.");
  }
  if (storedHash.length !== SHA256_HEX_LENGTH) {
    logger.warn("oidc: stored client secret hash has unexpected length — rejecting", {
      module: "oidc",
      audit: true,
      event: "oauth.client_secret.stored_hash_length_mismatch",
      expected: SHA256_HEX_LENGTH,
      actual: storedHash.length,
    });
    return false;
  }
  // Both lengths are the known constant — safe to use timingSafeEqual.
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return timingSafeEqual(a, b);
}

interface OidcBetterAuthPluginsOptions {
  /**
   * ClientIds of first-party (`skip_consent = true`) OAuth clients known at
   * boot. Forwarded to `oauthProvider({ cachedTrustedClients })` so the
   * plugin's in-memory TTLCache short-circuits the DB lookup on authorize /
   * introspect / revoke for trusted clients. Static snapshot — clients
   * promoted to first-party post-boot fall back to the regular DB lookup
   * until the next restart. See `listFirstPartyClientIds` in
   * `services/oauth-admin.ts`.
   */
  cachedTrustedClientIds?: readonly string[];
}

/**
 * Platform policy gate for a CIMD `client_id` URL, run before the document is
 * fetched. The LITERAL denylist (`@appstrate/core/ssrf`) — IP literals,
 * `localhost`, cloud-metadata names and the run network's Docker aliases
 * `sidecar` / `agent`, which upstream's public-routability check lets through
 * as ordinary names. No DNS here: resolving would re-open the TOCTOU window the
 * pinned transport closes. `isBlockedUrl` is total over strings, so a malformed
 * URL reads as blocked.
 *
 * Exported for unit testing — not part of the module's public surface.
 */
export function isCimdMetadataDocumentUrlAllowed(clientIdUrl: string): boolean {
  return !isBlockedUrl(clientIdUrl);
}

export function oidcBetterAuthPlugins(opts: OidcBetterAuthPluginsOptions = {}): unknown[] {
  const env = getEnv();
  // Scopes a self-service (DCR / CIMD) client may request: identity scopes +
  // module-contributed end-user-grantable scopes (currently mcp:read/invoke).
  // Deliberately EXCLUDES core action scopes (agents:run, llm-proxy:call, …) —
  // those remain for admin-managed first-party clients. The user-consent screen
  // and the caller's own permissions still gate the actual grant on top of this.
  const selfServiceScopes = getSelfServiceScopes();
  const cachedTrustedClients =
    opts.cachedTrustedClientIds && opts.cachedTrustedClientIds.length > 0
      ? new Set(opts.cachedTrustedClientIds)
      : undefined;
  return [
    oidcGuardsPlugin(),
    socialOverridePlugin(),
    jwt({
      jwks: { keyPairConfig: { alg: "ES256" } },
    }),
    // Accept `Authorization: Bearer <raw_session_token>` as a session
    // credential. The plugin reads the token, looks up the session via
    // the internal adapter, and populates the request context
    // identically to a cookie session so every downstream hook
    // (`requirePlatformRealm`, org membership, etc.) sees the correct
    // identity. The Appstrate CLI does not use this path — it presents
    // a JWT obtained from `/cli/token` (issue #165) verified through
    // the `oidc-jwt` strategy — but BA's bearer surface is kept
    // available for any third-party caller carrying a raw BA session
    // token (e.g. legacy integrations).
    bearer(),
    // CLI token plugin (issue #165) — exposes `/api/auth/cli/token` and
    // `/api/auth/cli/revoke` for the 2.x appstrate CLI. Runs ALONGSIDE
    // BA's default `deviceAuthorization()` plugin below; the device-flow
    // `/device/code`, `/device/approve`, `/device/deny` endpoints are
    // reused unchanged (no reason to duplicate the user-facing surface).
    // The CLI only substitutes the polling endpoint to receive JWT +
    // rotating refresh instead of a 7-day BA session.
    cliTokenPlugin(),
    deviceAuthorization({
      expiresIn: "10m",
      // 2s polling interval — RFC 8628 §3.2 suggests 5s as a *default*, not a
      // floor. `gh auth login`, `gcloud auth login`, and `aws sso login` all
      // sit in the 1–2s band for snappier CLI UX (median perceived latency
      // between browser approval and CLI detection drops from ~2.5s to ~1s,
      // worst case from 5s to 2s). The server-side `slow_down` guard in
      // `cli-tokens.ts::exchangeDeviceCodeForTokens` keys off this same
      // `pollingInterval` column, so both sides stay consistent. The load
      // cost is negligible: one poll every 2s per CLI in active login,
      // capped by the 10-min `expiresIn`.
      interval: "2s",
      userCodeLength: 8,
      generateUserCode: generateAppstrateUserCode,
      // Full URL so the CLI displays a click-through link. Relative paths
      // are resolved against BA's baseURL (`/api/auth`) which is not where
      // the `/activate` SSR page lives — mounted at the HTTP origin root
      // alongside the other OIDC pages.
      verificationUri: `${env.APP_URL}/activate`,
      // Gate: only OAuth clients registered with the device-flow grant are
      // allowed to hit `/device/code`. BA itself does NOT consult
      // `oauth_clients`, so we bridge the check via a direct DB lookup.
      // Realm/audience enforcement is a separate concern layered in
      // `oidcGuardsPlugin.hooks.before` on `/device/approve`.
      validateClient: validateDeviceFlowClient,
    }),
    // `satisfies` is load-bearing, not decoration. `oauthProvider` is declared
    // `<O extends OAuthOptions<Scope[]>>(options: O)` — a NAKED type parameter,
    // so TypeScript infers `O` as this literal's own type and performs no
    // excess-property check at all: a misspelled or non-existent option compiles
    // clean and is silently ignored. Checking the literal against the interface
    // first restores TS2353. Do not remove.
    oauthProvider({
      loginPage: "/api/oauth/login",
      consentPage: "/api/oauth/consent",
      // OIDC scope vocabulary (identity scopes + OIDC_ALLOWED_SCOPES). Owned
      // wholly by this module — there is no cross-module scope contribution
      // point, so load ordering is irrelevant. Advertised in discovery
      // `scopes_supported` and enforced by the oauth-provider plugin's own
      // scope filter.
      scopes: [...getAppstrateScopes()],
      // RFC 8707 protected resources, PERSISTED as `oauth_resources` rows. The
      // AS resolves a requested `resource` against that table on every token
      // call and answers `invalid_target` for an identifier it has no row for.
      // Seeded here are the two STATIC platform identifiers; the inbound MCP
      // server is exposed per organization (`/api/mcp/o/:org`), so its resources
      // are NOT static — the mcp module writes one row per org
      // (`modules/mcp/index.ts`). There is no bare `/api/mcp` resource.
      //
      // `resourceSeedMode` is left at its `insertOnly` default: a row an
      // operator edited must survive a restart. `cachedResources` is
      // deliberately NOT passed — an identifier outside that set is read from
      // the DB per request, which is exactly what makes an org row inserted at
      // runtime mintable immediately, including from another replica. The
      // implicit `${baseURL}/oauth2/userinfo` identifier is accepted without a
      // row and must never get one.
      resources: [env.APP_URL, `${env.APP_URL}/api/auth`],
      // Upstream defaults this to TRUE, which would require an
      // `oauth_client_resources` row per (client, resource) pair before any
      // mint. Appstrate does not model per-client resource linkage: any client
      // may request any configured resource, and the confinement that actually
      // holds is (a) the self-service rule in `guards.ts` — exactly one
      // protected resource, never the platform audience — and (b) the
      // downstream org-membership check on every request. `false` preserves
      // that behaviour byte for byte. Tightening it is a product decision, not
      // a dependency-bump side effect.
      enforcePerClientResources: false,
      cachedTrustedClients,
      // Dynamic Client Registration (RFC 7591) — the fallback discovery path
      // for MCP clients that can't host a CIMD document. Unauthenticated
      // registration is what lets a fresh `claude mcp add` self-register with
      // no operator step. Bounded hard: registrants may only request the
      // self-service scope set (identity + module scopes), PKCE is enforced by
      // the plugin, and the /oauth2/register endpoint is rate-limited in
      // routes.ts. The user-consent screen remains the real authorization gate.
      // Default and ceiling are ONE array, so they cannot drift: the provider
      // unions them, and a default outside the ceiling would widen it silently.
      //
      // A registration `scope` is ADVISORY (issue #1351). The provider validates
      // it against the union above and then persists that union verbatim
      // (`persistOAuthClientRegistration`), so a client declaring `openid` may
      // still ask for `mcp:invoke` at `/authorize`. Upstream documents this: the
      // persisted set is an operator-approved CAPABILITY set a later user
      // authorization steps up within, and a registration request "is not an
      // authorization grant". We do not narrow it back down, because the
      // declaration is CLIENT-CONTROLLED — the same registrant re-registers, or
      // edits its metadata document, and declares the whole ceiling instead.
      // Honouring it would buy no confinement and would break every MCP client
      // that publishes a minimal `scope` and then requests what the protected
      // resource advertises. The gates that hold are this ceiling, the consent
      // screen, and the caller's live role. See README § "Self-service client
      // registration (DCR / CIMD)".
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultScopes: selfServiceScopes,
      clientRegistrationAllowedScopes: selfServiceScopes,
      // The grants the AS actually serves. Upstream's default adds
      // `client_credentials`, which no Appstrate client registers and no code
      // path issues — advertising it in discovery invites a request that can
      // only fail.
      grantTypes: ["authorization_code", "refresh_token"],
      // Per-IP budgets for the unauthenticated endpoints the provider mounts,
      // enforced by Better Auth against the platform's shared limiter
      // (`rateLimit.customStorage`), so one budget spans the fleet. Each value
      // is the tighter of the provider's default and the platform's own
      // ceiling. `register` inserts an `oauth_clients` row per call, hence the
      // smallest budget. `userinfo` keeps the provider default: it is
      // session-authenticated.
      //
      // Per-IP is the whole model here: there is no per-client budget, and the
      // credential-guessing surface is covered by BA's own `/sign-in*` rule.
      rateLimit: {
        token: { window: 60, max: 20 },
        authorize: { window: 60, max: 30 },
        introspect: { window: 60, max: 60 },
        revoke: { window: 60, max: 30 },
        register: { window: 60, max: 5 },
      },
      storeClientSecret: {
        hash: hashSecret,
        verify: sha256HexVerify,
      },

      extensions: [
        {
          claims: {
            // Polymorphic claim builder. A claim extension is handed the
            // resolved `oauth_clients` row, so the level dispatch reads a
            // platform column instead of the provider-owned `metadata` JSON that
            // `customAccessTokenClaims` would hand it. Re-derived identically at
            // opaque-token introspection, and a throw here fails the mint.
            accessToken: ({ user, client }) => buildClaimsForClient(user ?? null, client.clientId),
          },
        },
      ],

      /**
       * Surface the same polymorphic claims on /userinfo so satellites can
       * read identity without decoding the JWT themselves. The Better Auth
       * oauth-provider plugin only passes us `{ user, scopes, jwt }` —
       * `jwt` is the decoded custom claims object from the access token,
       * so we can forward its identity claims verbatim.
       */
      customUserInfoClaims: async ({ jwt, user }) => {
        const claims = (jwt ?? {}) as Record<string, unknown>;
        const actorType = claims.actor_type;
        if (actorType !== "dashboard_user" && actorType !== "end_user" && actorType !== "user") {
          return {};
        }
        const base = {
          actor_type: actorType,
          email: str(claims.email) ?? user?.email,
          name: str(claims.name) ?? user?.name,
        };
        if (actorType === "end_user") {
          return {
            ...base,
            org_id: strOrNull(claims.org_id),
            space_id: strOrNull(claims.space_id),
            end_user_id: strOrNull(claims.end_user_id),
          };
        }
        const withVerified = {
          ...base,
          email_verified:
            typeof claims.email_verified === "boolean" ? claims.email_verified : false,
        };
        if (actorType === "dashboard_user") {
          return {
            ...withVerified,
            org_id: strOrNull(claims.org_id),
            org_role: strOrNull(claims.org_role),
          };
        }
        return withVerified;
      },
    } satisfies OAuthOptions<Scope[]>),
    // Client ID Metadata Documents (CIMD, SEP-991) — the MCP-spec-preferred
    // discovery path: a client identifies by an HTTPS URL whose document the AS
    // fetches, validates, and caches. Must come AFTER oauthProvider — its
    // init() appends a clientDiscovery entry to the provider and advertises
    // `client_id_metadata_document_supported` in the well-known metadata.
    //
    // The plugin enforces a 5s timeout, a 5KB body cap, JSON-only, and a
    // bounded request-amplification budget. Origin binding (post-logout and
    // client URIs must share the client_id origin; redirect URIs deliberately
    // excluded upstream, exact matching at authorization time covering them)
    // is left at its default.
    cimd({
      // The metadata-document transport is the AS's SSRF boundary and upstream
      // makes it the application's responsibility: resolve the hostname EXACTLY
      // ONCE, refuse every non-public-routable answer, connect to that pinned
      // address and never follow a redirect. Wrapping `fetch` cannot express
      // that — it re-resolves after any check, leaving a DNS-rebind window open.
      // `@better-auth/cimd/node` is upstream's conforming implementation; it
      // reaches for `node:dns`/`node:https`, and Bun exposes no address-pinning
      // seam that would satisfy the contract.
      //
      // Called through a lambda so the module binding is read per request: the
      // integration suite replaces the upstream export to serve a document
      // in-process, and plugins are built once, at boot.
      fetchClientMetadataResource: (input, init) => fetchClientMetadataResource(input, init),
      // MCP 2026-07-28 pins CIMD draft-00, which makes `client_name` and
      // `redirect_uris` mandatory. MCP clients are who this path serves, and a
      // document missing either cannot complete an authorization anyway.
      metadataProfile: "mcp-2026-07-28",
      isMetadataDocumentUrlAllowed: isCimdMetadataDocumentUrlAllowed,
      // A CIMD client is written straight to the DB by the plugin with no
      // platform discriminator, so its tokens would be rejected for a missing
      // level. Stamp it as a self-service instance client (same model as a DCR
      // client): it mints instance tokens, which the RFC 8707 audience
      // confinement then restricts to one protected resource.
      onClientCreated: async ({ client }) => {
        await markClientSelfService(client.clientId);
      },
      // A refresh rewrites the row from the re-fetched document, so re-assert
      // the stamp on every one. Idempotent.
      onClientRefreshed: async ({ client }) => {
        await markClientSelfService(client.clientId);
      },
    }),
  ];
}

/**
 * User code alphabet — GitHub's convention. Excludes vowels (prevents
 * accidental dictionary words from forming), `0/O` and `1/I/L` (visually
 * ambiguous), and digits (we want an all-letter code). 20 chars × 8
 * positions = 20^8 ≈ 2.56e10 ≈ 34.6 bits of entropy before the one-time
 * user-code rate limiter ever kicks in.
 */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/**
 * Cryptographically random 8-character user code. Returned WITHOUT the
 * `XXXX-XXXX` separator because BA's `/device/verify` and `/device/approve`
 * strip dashes from the user-typed code before looking up the record
 * (see `better-auth/plugins/device-authorization/routes.mjs`) — if we
 * stored the formatted version, the lookup would miss. The separator is
 * a pure display concern and is re-inserted by the CLI output and the
 * `/activate` SSR page when showing the code to humans.
 */
function generateAppstrateUserCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) {
    raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return raw;
}

/**
 * Allowlist callback invoked by BA's deviceAuthorization plugin at
 * `/device/code` (initial request) and on its built-in `/device/token`
 * exchange path (which Appstrate doesn't use first-party but BA still
 * mounts). Returns `true` only for OAuth clients whose registered
 * `grantTypes` include the RFC 8628 device-code grant. The instance-level `appstrate-cli` client
 * (auto-provisioned by `ensureCliClient()`) is the canonical holder. Other
 * clients can opt in by declaring the grant, but the realm/level guard on
 * `/device/approve` still governs who can approve — this function only
 * answers "is this client allowed to use device flow at all?".
 */
async function validateDeviceFlowClient(clientId: string): Promise<boolean> {
  const [row] = await db
    .select({ grantTypes: oauthClient.grantTypes, disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row) return false;
  if (row.disabled === true) return false;
  const grants = row.grantTypes ?? [];
  return grants.includes("urn:ietf:params:oauth:grant-type:device_code");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function strOrNull(value: unknown): string | null {
  return str(value) ?? null;
}

/**
 * Dispatch on the client row's `level` column. The row is read through the
 * short-TTL client cache; `level` and the `referenced_*` FKs are immutable for
 * a client's lifetime (`oauth_clients_level_immutable` trigger), so a cached
 * copy cannot answer a stale level.
 */
async function buildClaimsForClient(
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean } | null,
  clientId: string,
): Promise<Record<string, unknown>> {
  if (!user) return {};
  const client = await getClientCached(clientId);
  if (!client) {
    logger.warn("oidc: token requested for an unknown oauth_client — rejecting", {
      module: "oidc",
      userId: user.id,
      clientId,
    });
    throw new APIError("BAD_REQUEST", {
      message: "Unknown OAuth client — cannot issue token",
    });
  }
  if (client.level === "instance") return buildInstanceLevelClaims(user);
  if (client.level === "org") return buildOrgLevelClaims(user, client);
  return buildSpaceLevelClaims(user, client);
}

async function buildInstanceLevelClaims(user: {
  id: string;
  email: string;
  name?: string | null;
  emailVerified?: boolean;
}): Promise<Record<string, unknown>> {
  // Instance clients serve platform audiences — dashboard SPA + satellite
  // admin tools. Reject end-user realm sessions so an OIDC token minted
  // under space A's scope cannot be replayed to mint an instance token.
  await assertUserRealm(user.id, "platform", { clientLevel: "instance" });
  // Instance tokens carry NO org or space context. The user is a
  // Better Auth user who may belong to multiple organizations — org is
  // resolved per-request via X-Org-Id after authentication.
  return {
    actor_type: "user",
    email: user.email,
    email_verified: user.emailVerified === true,
    name: user.name ?? user.email,
  };
}

async function buildOrgLevelClaims(
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean },
  client: OAuthClientRecord,
): Promise<Record<string, unknown>> {
  const orgId = client.referencedOrgId;
  if (!orgId) {
    logger.warn("oidc: org-level client missing referencedOrgId — rejecting token", {
      module: "oidc",
      userId: user.id,
    });
    throw new APIError("BAD_REQUEST", {
      message: "Invalid OAuth client configuration",
    });
  }

  // Dashboard SSO gate: org must have opted in via
  // orgSettings.dashboard_sso_enabled. Mirrors the interactive-flow gate in
  // routes.ts/loadPageContext — this is the authoritative token-mint check
  // that also catches non-interactive flows (refresh, client_credentials).
  const orgSettings = await getOrgSettings(orgId);
  if (orgSettings.dashboard_sso_enabled !== true) {
    logger.warn("oidc: dashboard SSO disabled for org — rejecting token", {
      module: "oidc",
      userId: user.id,
      orgId,
    });
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "Dashboard SSO is disabled for this organization.",
    });
  }

  // Org-level clients serve platform audiences (dashboard users mapped to
  // org_members). Reject end-user realm sessions — an end-user of space A
  // cannot become a dashboard user of org X by OIDC replay.
  await assertUserRealm(user.id, "platform", { clientLevel: "org", orgId });

  // Load the mutable signup policy via the short-TTL client cache. Falls
  // back to the "closed" default if the client was deleted/disabled or its
  // metadata drifted — better to reject a legitimate mint than silently
  // auto-join to a wrong role.
  const loaded = await loadClientSignupPolicy(client.clientId);
  const policy: Parameters<typeof resolveOrCreateOrgMembership>[2] =
    loaded && loaded.level === "org" && loaded.orgId === orgId
      ? {
          allowSignup: loaded.allowSignup,
          signupRole: loaded.signupRole,
          signupSpaceAssignments: loaded.signupSpaceAssignments,
        }
      : { allowSignup: false, signupRole: "member" };

  // Resolve or create the membership. For existing members this is a
  // single SELECT (the proactive call in routes.ts already created the row
  // for new members during password login / register; this re-check is a
  // no-op for them). For social / magic-link flows where the proactive call
  // never ran, the auto-join happens here.
  //
  // NOTE: the BA `databaseHooks.user.create.before` guard
  // (`auth/signup-guard.ts`) already blocks brand-new BA users for closed
  // org-level clients BEFORE they reach this point. This path remains as
  // defense in depth for existing-but-unaffiliated BA users (e.g. a user
  // who created an account elsewhere and is now trying to access a closed
  // client).
  try {
    const resolved = await resolveOrCreateOrgMembership(
      { id: user.id, email: user.email },
      orgId,
      policy,
    );
    return {
      actor_type: "dashboard_user",
      email: user.email,
      email_verified: user.emailVerified === true,
      name: user.name ?? user.email,
      org_id: orgId,
      org_role: resolved.role,
    };
  } catch (err) {
    if (err instanceof OrgSignupConfigurationError) {
      throw new APIError("FORBIDDEN", { error: "access_denied", error_description: err.message });
    }
    if (err instanceof OrgSignupClosedError) {
      logger.warn("oidc: user is not a member of the pinned org — rejecting token", {
        module: "oidc",
        userId: user.id,
        orgId,
      });
      // Structured OAuth2 error so satellites (portal) can render a clean
      // membership-error page instead of a generic 500. Uses RFC 6749
      // `access_denied` since RFC does not define a more specific code.
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        error_description:
          "Registration is disabled for this space. Contact your administrator to be added to the organization.",
      });
    }
    throw err;
  }
}

async function buildSpaceLevelClaims(
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean },
  client: OAuthClientRecord,
): Promise<Record<string, unknown>> {
  const spaceId = client.referencedSpaceId;
  if (!spaceId) {
    logger.warn("oidc: space-level client missing referencedSpaceId — rejecting token", {
      module: "oidc",
      userId: user.id,
    });
    // Structured OAuth2 error (like the org-level path) so the caller gets a
    // diagnosable body instead of a bare Error that BA surfaces as an opaque
    // 500. The client's server-side config is broken, not the request.
    throw new APIError("INTERNAL_SERVER_ERROR", {
      error: "server_error",
      error_description:
        "This space client is misconfigured (no space is bound to it). Contact the administrator.",
    });
  }
  const space = await loadSpaceById(spaceId);
  if (!space) {
    logger.warn("oidc: space referenced by oauth_client has been deleted", {
      module: "oidc",
      userId: user.id,
      spaceId,
    });
    throw new APIError("INTERNAL_SERVER_ERROR", {
      error: "server_error",
      error_description:
        "The space bound to this client no longer exists. Contact the administrator.",
    });
  }

  // Space-level tokens are end-user tokens. Enforce that the
  // authenticating BA user was provisioned for THIS space — reject
  // platform admins (realm="platform") and end-users of a different space
  // (realm="end_user:B"). Per decision #2 (no cross-audience sharing),
  // a platform admin wanting to test their own space as an end-user must
  // re-signup with a separate account.
  await assertUserRealm(user.id, `end_user:${spaceId}`, {
    clientLevel: "space",
    spaceId,
  });
  // Load the signup policy via the short-TTL cache — closed default on any
  // lookup failure. Same rationale as `buildOrgLevelClaims`.
  const loaded = await loadClientSignupPolicy(client.clientId);
  const signupPolicy = {
    allowSignup: loaded?.level === "space" && loaded.spaceId === spaceId && loaded.allowSignup,
  };

  // NOTE: this call may be the SECOND invocation for a given login —
  // `routes.ts` POST /api/oauth/login pre-resolves the end-user to surface
  // `UnverifiedEmailConflictError` as a 409 before the redirect chain. That
  // first call is idempotent (step-1 SELECT lookup via `findLinkedEndUser`
  // on repeat calls), so this second invocation is a no-op for the happy
  // path. Do NOT add observable side effects here without making them
  // "first-call only" — see the matching warning in routes.ts.
  try {
    const resolved = await resolveOrCreateEndUser(
      {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        emailVerified: user.emailVerified === true,
      },
      space,
      signupPolicy,
    );
    return {
      actor_type: "end_user",
      email: resolved.email ?? user.email,
      name: resolved.name ?? user.name ?? user.email,
      org_id: resolved.orgId,
      space_id: resolved.spaceId,
      end_user_id: resolved.endUserId,
    };
  } catch (err) {
    if (err instanceof UnverifiedEmailConflictError) {
      logger.warn("oidc: unverified-email conflict during token issuance", {
        module: "oidc",
        spaceId: err.spaceId,
        email: err.email,
      });
      throw err;
    }
    if (err instanceof SpaceSignupClosedError) {
      logger.warn("oidc: end-user signup blocked by client policy", {
        module: "oidc",
        spaceId: err.spaceId,
        authUserId: err.authUserId,
      });
      // Map to a structured OAuth2 error so downstream satellites (portal)
      // can render a "contact your admin" page instead of a generic 500.
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        error_description:
          "Sign-up is disabled for this space. Ask your administrator to create your account before signing in.",
      });
    }
    logger.error("oidc: end-user resolution failed during token issuance", {
      module: "oidc",
      userId: user.id,
      spaceId,
      error: getErrorMessage(err),
    });
    throw err;
  }
}
