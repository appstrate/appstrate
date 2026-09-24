// SPDX-License-Identifier: Apache-2.0

/**
 * Casing gate over the whole OpenAPI spec (core + every module), per
 * `docs/CASING_CONVENTIONS.md`. It DISCOVERS leaks instead of checking known
 * names: every property name, query/path parameter name and example key that
 * holds an uppercase letter must be on `CAMEL_CASE_CARVE_OUTS` — the doc's
 * rule is name-based, a field qualifies only by its literal name. It also
 * fails on the snake_case twin of a 4b name (`created_at`, `run_id`, …),
 * which a camelCase-only check cannot see, outside `SNAKE_TWIN_EXCEPTIONS`.
 *
 * Both lists only shrink: an entry that no longer matches anything fails too.
 */

import { describe, expect, it } from "bun:test";
import { buildOpenApiSpec } from "../../src/openapi/index.ts";
import { collectModuleOpenApi } from "../../../../scripts/lib/module-openapi.ts";

const UNIVERSAL = "4b universal DB-convention field";
const PAGINATION = "pagination envelope / cursor params";

export const CAMEL_CASE_CARVE_OUTS: Record<string, string> = {
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

  keyPrefix: "4n headless-platform DTO",
  urlPrefix: "4n headless-platform DTO",
  externalId: "4n headless-platform DTO",
  isDefault: "4n headless-platform DTO",
  allowedRedirectDomains: "4n headless-platform DTO",
  payloadMode: "4n headless-platform DTO (webhook CRUD)",
  eventId: "4n headless-platform DTO (webhook CRUD)",
  eventType: "4n headless-platform DTO (webhook CRUD)",
  statusCode: "4n headless-platform DTO (webhook CRUD)",
  windowSeconds: "4n headless-platform DTO (webhook CRUD)",
  secretPrevious: "4n headless-platform DTO (webhook CRUD)",
  rotationWindowEndsAt: "4n headless-platform DTO (webhook CRUD)",

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

  modelId: "5c standalone model/proxy/credential ids",
  proxyId: "5c standalone model/proxy/credential ids",
  credentialId: "5c standalone model/proxy/credential ids",

  clientId: "5d Better Auth plugin mirror (OAuth clients)",
  clientSecret: "5d Better Auth plugin mirror (OAuth clients)",
  redirectUris: "5d Better Auth plugin mirror (OAuth clients)",
  postLogoutRedirectUris: "5d Better Auth plugin mirror (OAuth clients)",
  isFirstParty: "5d Better Auth plugin mirror (OAuth clients)",
  allowSignup: "5d Better Auth plugin mirror (OAuth clients)",
  signupRole: "5d Better Auth plugin mirror (OAuth clients)",
  signupSpaceAssignments: "5d Better Auth plugin mirror (OAuth clients)",
  referencedOrgId: "5d Better Auth plugin mirror (OAuth clients)",
  referencedSpaceId: "5d Better Auth plugin mirror (OAuth clients)",
  familyId: "5d Better Auth plugin mirror (CLI sessions)",
  deviceName: "5d Better Auth plugin mirror (CLI sessions)",
  userAgent: "5d Better Auth plugin mirror (CLI sessions)",
  createdIp: "5d Better Auth plugin mirror (CLI sessions)",
  lastUsedIp: "5d Better Auth plugin mirror (CLI sessions)",
  userName: "5d Better Auth plugin mirror (CLI sessions)",
  userEmail: "5d Better Auth plugin mirror (CLI sessions)",
  revokedCount: "5d Better Auth plugin mirror (CLI sessions)",
};

/**
 * Example subtrees whose keys are not API field names, so they are not
 * walked. Declared schemas are always walked: a property the spec names is a
 * field, whatever object it sits in.
 */
const OPAQUE_EXAMPLE_KEYS: Record<string, string> = {
  input: "runs.input — keyed by the agent's own input schema (4g)",
  checkpoint: "runs.checkpoint — agent-written (4g)",
  payload: "webhook delivery payload (4j)",
  headers: "HTTP field names (RFC 9110)",
};

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
    if (key in OPAQUE_EXAMPLE_KEYS) continue;
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
  it("spells every camelCase name from the carve-out list", () => {
    const leaks = camel.filter((f) => !(f.name in CAMEL_CASE_CARVE_OUTS));
    expect(leaks.map((f) => `${f.name} at ${f.at}`)).toEqual([]);
  });

  it("carries no carve-out entry that nothing uses", () => {
    const used = new Set(camel.map((f) => f.name));
    expect(Object.keys(CAMEL_CASE_CARVE_OUTS).filter((name) => !used.has(name))).toEqual([]);
  });

  it("spells no 4b name as its snake_case twin outside the enumerated exceptions", () => {
    const found = new Set(twins.map((f) => f.at));
    expect([...found].filter((at) => !SNAKE_TWIN_EXCEPTIONS.has(at)).sort()).toEqual([]);
    expect([...SNAKE_TWIN_EXCEPTIONS].filter((at) => !found.has(at))).toEqual([]);
  });
});
