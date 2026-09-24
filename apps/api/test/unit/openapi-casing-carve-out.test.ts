// SPDX-License-Identifier: Apache-2.0

/**
 * Casing gate over the whole OpenAPI spec (core + every module), per
 * `docs/CASING_CONVENTIONS.md`. It DISCOVERS leaks instead of checking known
 * names: every property name, query parameter name and example key that
 * holds an uppercase letter must be on `CAMEL_CASE_CARVE_OUTS`. Most entries
 * are name-based (the name qualifies wherever it appears); the 4n entries
 * belong to one headless-platform surface and the 5d entries mirror one Better
 * Auth plugin table, so both qualify only `within` the JSON pointers of that
 * surface. It also fails on the snake_case twin of a 4b name
 * (`created_at`, `run_id`, …), which a camelCase-only check cannot see,
 * outside `SNAKE_TWIN_EXCEPTIONS`.
 *
 * Every list only shrinks: an entry that matches nothing (within its scope)
 * fails too.
 */

import { describe, expect, it } from "bun:test";
import { buildOpenApiSpec } from "../../src/openapi/index.ts";
import { collectModuleOpenApi } from "../../../../scripts/lib/module-openapi.ts";

const UNIVERSAL = "4b universal DB-convention field";
const PAGINATION = "pagination envelope / cursor params";

/** A reason alone applies everywhere; `within` limits the entry to JSON-pointer prefixes. */
type CarveOut = string | { reason: string; within: readonly string[] };

const OAUTH_CLIENTS = {
  reason: "5d Better Auth plugin mirror (OAuth clients)",
  within: [
    "#/components/schemas/OAuthClientObject/",
    "#/components/schemas/OAuthClientWithSecret/",
    "#/paths/~1api~1oauth~1clients",
  ],
};
// 4n: each name is camelCase on the surface `docs/CASING_CONVENTIONS.md` names for it.
const API_KEYS = {
  reason: "4n headless-platform DTO (API keys)",
  within: ["#/components/schemas/ApiKeyInfo/", "#/paths/~1api~1api-keys"],
};
const PROXIES = {
  reason: "4n headless-platform DTO (proxies)",
  within: ["#/components/schemas/OrgProxy/", "#/paths/~1api~1proxies"],
};
const LIBRARY_SPACES = "get/responses/200/content/application~1json";
const SPACES_END_USERS = {
  reason: "4n headless-platform DTO (spaces, end-users)",
  within: [
    "#/components/schemas/SpaceObject/",
    "#/components/schemas/EndUserObject/",
    "#/paths/~1api~1spaces",
    "#/paths/~1api~1end-users",
    // The library lists the spaces a package can be placed in, as space rows.
    `#/paths/~1api~1library/${LIBRARY_SPACES}/schema/properties/spaces/`,
    `#/paths/~1api~1library/${LIBRARY_SPACES}/example/spaces/`,
  ],
};
const WEBHOOKS = {
  reason: "4n headless-platform DTO (webhook CRUD)",
  within: ["#/components/schemas/WebhookObject/", "#/paths/~1api~1webhooks"],
};
const CLI_SESSIONS = {
  reason: "5d Better Auth plugin mirror (CLI sessions)",
  within: ["#/paths/~1api~1auth~1cli~1", "#/paths/~1api~1orgs~1{orgId}~1cli-sessions"],
};

export const CAMEL_CASE_CARVE_OUTS: Record<string, CarveOut> = {
  createdAt: UNIVERSAL,
  updatedAt: UNIVERSAL,
  expiresAt: UNIVERSAL,
  revokedAt: UNIVERSAL,
  lastUsedAt: UNIVERSAL,
  userId: UNIVERSAL,
  orgId: UNIVERSAL,
  spaceId: UNIVERSAL,
  packageId: UNIVERSAL,
  runId: UNIVERSAL,
  endUserId: UNIVERSAL,
  apiKeyId: UNIVERSAL,
  scheduleId: UNIVERSAL,
  modelCredentialId: UNIVERSAL,
  runNumber: UNIVERSAL,
  runOrigin: UNIVERSAL,
  contextSnapshot: UNIVERSAL,

  hasMore: PAGINATION,
  startingAfter: PAGINATION,
  endingBefore: PAGINATION,

  keyPrefix: API_KEYS,
  urlPrefix: PROXIES,
  externalId: SPACES_END_USERS,
  isDefault: SPACES_END_USERS,
  allowedRedirectDomains: SPACES_END_USERS,
  payloadMode: WEBHOOKS,
  eventId: WEBHOOKS,
  eventType: WEBHOOKS,
  statusCode: WEBHOOKS,
  windowSeconds: WEBHOOKS,
  secretPrevious: WEBHOOKS,
  rotationWindowEndsAt: WEBHOOKS,

  displayName: "4c Better Auth profile/member DTO; 4e provider registry",
  joinedAt: "4c Better Auth member DTO",
  newPassword: "4c Better Auth setPassword mirror",

  providerId: "4e model-provider registry",
  apiShape: "4e model-provider registry",
  authMode: "4e model-provider registry",
  iconUrl: "4e model-provider registry",
  defaultBaseUrl: "4e model-provider registry",
  baseUrlOverridable: "4e model-provider registry",
  docsUrl: "4e model-provider registry",
  contextWindow: "4e model-provider registry",
  maxTokens: "4e model-provider registry",
  cacheRead: "4e model-provider registry (cost)",
  cacheWrite: "4e model-provider registry (cost)",

  durationMs: "4i canonical run events (runner finalize body)",

  modelId: "5c org model/proxy/credential ids",
  proxyId: "5c org model/proxy/credential ids",
  credentialId: "5c org model/proxy/credential ids",

  clientId: OAUTH_CLIENTS,
  clientSecret: OAUTH_CLIENTS,
  redirectUris: OAUTH_CLIENTS,
  postLogoutRedirectUris: OAUTH_CLIENTS,
  isFirstParty: OAUTH_CLIENTS,
  allowSignup: OAUTH_CLIENTS,
  signupRole: OAUTH_CLIENTS,
  signupSpaceAssignments: OAUTH_CLIENTS,
  referencedOrgId: OAUTH_CLIENTS,
  referencedSpaceId: OAUTH_CLIENTS,
  familyId: CLI_SESSIONS,
  deviceName: CLI_SESSIONS,
  userAgent: CLI_SESSIONS,
  createdIp: CLI_SESSIONS,
  lastUsedIp: CLI_SESSIONS,
  userName: CLI_SESSIONS,
  userEmail: CLI_SESSIONS,
  revokedCount: CLI_SESSIONS,
};

/**
 * Example subtrees whose keys are not API field names, so they are not
 * walked. Declared schemas are always walked: a property the spec names is a
 * field, whatever object it sits in.
 */
const OPAQUE_EXAMPLE_KEYS: Record<string, CarveOut> = {
  input: "runs.input — keyed by the agent's own input schema (4g)",
  checkpoint: "runs.checkpoint — agent-written (4g)",
  payload: { reason: "webhook delivery payload (4j)", within: ["#/paths/~1api~1webhooks"] },
  headers: "HTTP field names (RFC 9110)",
};

const applies = (entry: CarveOut | undefined, at: string) =>
  entry !== undefined &&
  (typeof entry === "string" || entry.within.some((prefix) => at.startsWith(prefix)));

const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const SNAKE_TWINS = new Set(
  Object.entries(CAMEL_CASE_CARVE_OUTS)
    .filter(([, section]) => section === UNIVERSAL || section === PAGINATION)
    .map(([name]) => toSnake(name)),
);

const SNAKE_TWIN_EXCEPTIONS = new Set([
  // The enumerated counter-exception of the placement / share family.
  "#/components/schemas/PackagePlacement/properties/space_id",
  "#/components/schemas/PackagePlacement/properties/shared_by/properties/user_id",
  "#/components/schemas/PackageShare/properties/shared_by/properties/user_id",
  // Internal sidecar↔platform wire, documented snake_case end to end.
  "#/components/schemas/IntegrationCredentialsResponse/properties/auths/items/properties/expires_at",
  // OAuth 2.0 token endpoint (Zone 1, RFC 6749 wire).
  "#/paths/~1api~1auth~1oauth2~1token/post/responses/200/content/application~1json/schema/properties/expires_at",
]);

interface Finding {
  name: string;
  at: string;
}

const pointer = (base: string, key: string | number) =>
  `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

function walkExample(value: unknown, at: string, camel: Finding[]): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (applies(OPAQUE_EXAMPLE_KEYS[key], at)) continue;
    if (!Array.isArray(value) && /[A-Z]/.test(key)) camel.push({ name: key, at: pointer(at, key) });
    walkExample(child, pointer(at, key), camel);
  }
}

/** Walks any spec node; `properties` maps, parameters and examples are where names live. */
function walkSpec(node: unknown, at: string, camel: Finding[], twins: Finding[]): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // Path-template names are route identifiers, not wire: only their values travel.
  if (obj.in === "query" && typeof obj.name === "string") {
    if (/[A-Z]/.test(obj.name)) camel.push({ name: obj.name, at });
    if (SNAKE_TWINS.has(obj.name)) twins.push({ name: obj.name, at });
  }
  for (const [key, child] of Object.entries(obj)) {
    const here = pointer(at, key);
    if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) {
      for (const [name, schema] of Object.entries(child)) {
        const field = pointer(here, name);
        if (/[A-Z]/.test(name)) camel.push({ name, at: field });
        if (SNAKE_TWINS.has(name)) twins.push({ name, at: field });
        walkSpec(schema, field, camel, twins);
      }
    } else if (key === "example" || key === "default") {
      walkExample(child, here, camel);
    } else if (key === "examples" && child && typeof child === "object") {
      for (const [name, example] of Object.entries(child)) {
        const value = Array.isArray(child) ? example : (example as { value?: unknown })?.value;
        walkExample(value, pointer(here, name), camel);
      }
    } else {
      walkSpec(child, here, camel, twins);
    }
  }
}

async function scan(): Promise<{ camel: Finding[]; twins: Finding[] }> {
  const modules = await collectModuleOpenApi();
  const spec = buildOpenApiSpec(modules.paths, modules.componentSchemas, modules.tags) as {
    paths: unknown;
    components: unknown;
  };
  const camel: Finding[] = [];
  const twins: Finding[] = [];
  walkSpec(spec.components, "#/components", camel, twins);
  walkSpec(spec.paths, "#/paths", camel, twins);
  return { camel, twins };
}

const { camel, twins } = await scan();

describe("OpenAPI casing", () => {
  const allowed = (f: Finding) => applies(CAMEL_CASE_CARVE_OUTS[f.name], f.at);

  it("spells every camelCase name from the carve-out list, within its scope", () => {
    expect(camel.filter((f) => !allowed(f)).map((f) => `${f.name} at ${f.at}`)).toEqual([]);
  });

  it("carries no carve-out entry that nothing uses within its scope", () => {
    const used = new Set(camel.filter(allowed).map((f) => f.name));
    expect(Object.keys(CAMEL_CASE_CARVE_OUTS).filter((name) => !used.has(name))).toEqual([]);
  });

  it("spells no 4b name as its snake_case twin outside the enumerated exceptions", () => {
    const found = new Set(twins.map((f) => f.at));
    expect([...found].filter((at) => !SNAKE_TWIN_EXCEPTIONS.has(at)).sort()).toEqual([]);
    expect([...SNAKE_TWIN_EXCEPTIONS].filter((at) => !found.has(at))).toEqual([]);
  });
});
