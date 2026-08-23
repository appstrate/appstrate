// SPDX-License-Identifier: Apache-2.0

/**
 * Pure fixture-recorder machinery. The Playwright runner lives in `record.mjs`;
 * keeping the policy here makes privacy and contract behavior cheap to test.
 */

const SENSITIVE_KEY =
  /^(authorization|cookie|setcookie|credentials?|password|passwd|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|sessiontoken|apikey|privatekey|signingkey)$/i;
const SENSITIVE_QUERY_KEY =
  /^(authorization|credentials?|password|passwd|secret|signature|sig|token|accesstoken|refreshtoken|idtoken|sessiontoken|apikey|privatekey|signingkey|code|xamzsignature)$/i;
const FORCED_ID_KEY = /(_by$|^(?:created|updated)By$)/i;
const QUERY_ID_KEY = /(^id$|id$|_id$|^cursor$)/i;
const HASH_KEY = /(checksum|digest|fingerprint|hash|integrity|sha\d*)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\//i;
const DATE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL_ID_RE =
  /^(?:app|org|usr|user|eu|run|doc|sched|wh|key|conn|mpc|mdl|prx|sess|inv|upl)_[A-Za-z0-9_-]+$/;
const DYNAMIC_KEY_ID_RE =
  /^(?:app|org|usr|user|eu|run|doc|sched|wh|key|conn|mpc|mdl|prx|sess|inv|upl)_[A-Za-z0-9_-]{6,}$/;
const LONG_HEX_RE = /^(?:[0-9a-f]{32,})$/i;
const KEY_ALIAS_KINDS = new Set(["scope", "agent", "id", "org", "app"]);
const JSON_SCHEMA_KEYS = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contentEncoding",
  "contentMediaType",
  "contains",
  "deprecated",
  "description",
  "else",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "title",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
  "writeOnly",
]);
const CREDENTIAL_SCHEMA_WRAPPER_KEYS = new Set([
  "file_constraints",
  "property_order",
  "schema",
  "ui_hints",
]);

export class UnsafeFixtureValueError extends Error {
  constructor(path, reason) {
    super(`Unsafe fixture value at ${path}: ${reason}`);
    this.name = "UnsafeFixtureValueError";
  }
}

export class Pseudonymizer {
  #maps = new Map();

  alias(kind, value) {
    if (value === undefined || value === null || value === "") return undefined;
    let values = this.#maps.get(kind);
    if (!values) {
      values = new Map();
      this.#maps.set(kind, values);
    }
    const known = values.get(value);
    if (known) return known;
    const alias = `${kind}_${values.size + 1}`;
    values.set(value, alias);
    return alias;
  }

  replaceKnown(value, kinds) {
    let sanitized = value;
    const replacements = [...this.#maps.entries()]
      .filter(([kind]) => !kinds || kinds.has(kind))
      .map(([, values]) => values)
      .flatMap((values) => [...values.entries()].map(([source, alias]) => ({ source, alias })))
      .filter(({ source }) => source.length >= 4)
      .sort((a, b) => b.source.length - a.source.length);
    for (const { source, alias } of replacements) sanitized = sanitized.replaceAll(source, alias);
    return sanitized;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templatePattern(template) {
  const parts = template.split(/(\{[^}]+\})/g).filter(Boolean);
  const source = parts
    .map((part) => (part.startsWith("{") ? "(.+?)" : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${source}$`);
}

/** Resolve a concrete browser path to the most specific live OpenAPI template. */
export function canonicalizeOpenApiPath(pathname, method, paths) {
  const loweredMethod = method.toLowerCase();
  const candidates = Object.entries(paths)
    .filter(([, item]) => item && typeof item === "object" && loweredMethod in item)
    .map(([template]) => ({
      template,
      staticLength: template.replace(/\{[^}]+\}/g, "").length,
      parameterCount: (template.match(/\{/g) ?? []).length,
    }))
    .sort(
      (a, b) =>
        b.staticLength - a.staticLength ||
        a.parameterCount - b.parameterCount ||
        b.template.length - a.template.length,
    );

  return (
    candidates.find(({ template }) => templatePattern(template).test(pathname))?.template ?? null
  );
}

function operationFor(openApi, path, method) {
  const pathItem = openApi.paths?.[path];
  if (!pathItem || typeof pathItem !== "object") return undefined;
  return pathItem[method.toLowerCase()];
}

function responseContentTypes(openApi, path, method, status) {
  const operation = operationFor(openApi, path, method);
  const response = operation?.responses?.[String(status)] ?? operation?.responses?.default;
  return Object.keys(response?.content ?? {});
}

/** Decide whether a response body may be read and emitted as a typed fixture. */
export function classifyResponse({ path, method, status, contentType, openApi }) {
  if (path.startsWith("/api/auth/")) {
    return { kind: "special", reason: "Better Auth response body is never recorded" };
  }
  if (status === 204) return { kind: "special", reason: "204 response has no body" };

  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (normalizedType === "text/event-stream") {
    return { kind: "special", reason: "SSE response is reported without reading its stream" };
  }
  if (
    normalizedType === "application/octet-stream" ||
    normalizedType.startsWith("image/") ||
    normalizedType.startsWith("audio/") ||
    normalizedType.startsWith("video/")
  ) {
    return { kind: "special", reason: "Binary response is reported without reading its body" };
  }
  if (status !== 200) {
    return { kind: "special", reason: `HTTP ${status} is not a nominal JSON 200 fixture` };
  }
  if (normalizedType !== "application/json") {
    return { kind: "special", reason: `Unsupported content type ${normalizedType || "(missing)"}` };
  }

  const documentedTypes = responseContentTypes(openApi, path, method, status);
  if (!documentedTypes.includes("application/json")) {
    return { kind: "special", reason: "OpenAPI does not declare a JSON 200 response" };
  }
  return { kind: "json200" };
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function looksLikeUnknownSecret(value) {
  if (value.length < 24 || /\s/.test(value)) return false;
  if (LONG_HEX_RE.test(value)) return true;
  const characterClasses = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(value),
  ).length;
  return characterClasses >= 3 && shannonEntropy(value) >= 4.1;
}

function replaceRecorderSeeds(value, pseudonymizer) {
  return value.replace(/fixture-recorder-[a-z0-9]+/gi, (seed) =>
    pseudonymizer.alias("agent", seed),
  );
}

function sanitizeUrl(value, pseudonymizer) {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new UnsafeFixtureValueError("url", "URL contains credentials");
  }
  const safeQuery = sanitizeQuery(url.searchParams, pseudonymizer);
  url.search = safeQuery;
  url.pathname = url.pathname
    .split("/")
    .map((segment) =>
      sanitizeString(decodeURIComponent(segment), "", "url.pathname", pseudonymizer),
    )
    .join("/");
  if (url.hash.length > 1) {
    const fragment = decodeURIComponent(url.hash.slice(1));
    url.hash = fragment.includes("=")
      ? sanitizeQuery(new URLSearchParams(fragment), pseudonymizer)
      : fragment
          .split("/")
          .map((segment) => sanitizeString(segment, "", "url.fragment", pseudonymizer))
          .join("/");
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    url.hostname = `${pseudonymizer.alias("service", url.hostname)}.example.invalid`;
    url.port = "";
  }
  return url.toString();
}

function sanitizeString(value, key, path, pseudonymizer) {
  if (/^\{\$credential\.[A-Za-z0-9_.-]+\}$/.test(value)) return value;
  if (DATE_RE.test(value)) return "2026-01-01T00:00:00.000Z";
  if (EMAIL_RE.test(value)) return `${pseudonymizer.alias("person", value)}@example.invalid`;
  if (URL_RE.test(value)) return sanitizeUrl(value, pseudonymizer);
  if (
    FORCED_ID_KEY.test(key) ||
    INTERNAL_ID_RE.test(value) ||
    UUID_RE.test(value) ||
    (key === "id" && looksLikeUnknownSecret(value))
  ) {
    return pseudonymizer.alias("id", value);
  }
  if (HASH_KEY.test(key)) return "0".repeat(Math.max(8, value.length));
  const knownSafeValue = replaceRecorderSeeds(pseudonymizer.replaceKnown(value), pseudonymizer);
  if (looksLikeUnknownSecret(knownSafeValue)) {
    throw new UnsafeFixtureValueError(path, "high-entropy string under an unrecognized key");
  }
  return knownSafeValue;
}

/** Sanitize a JSON body without mutating it. Unsafe values abort that fixture. */
export function sanitizeJson(value, pseudonymizer = new Pseudonymizer(), path = "$") {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value, "", path, pseudonymizer);
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeJson(item, pseudonymizer, `${path}[${index}]`));
  }
  if (typeof value !== "object") {
    throw new UnsafeFixtureValueError(path, `unsupported ${typeof value} value`);
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const safeKey =
      DYNAMIC_KEY_ID_RE.test(key) || UUID_RE.test(key)
        ? pseudonymizer.alias("id", key)
        : replaceRecorderSeeds(pseudonymizer.replaceKnown(key, KEY_ALIAS_KINDS), pseudonymizer);
    const normalizedKey = key.replace(/[-_]/g, "");
    const schemaProperty =
      path.endsWith(".properties") &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.keys(child).every((childKey) => JSON_SCHEMA_KEYS.has(childKey)) &&
      ("type" in child ||
        "$ref" in child ||
        "allOf" in child ||
        "oneOf" in child ||
        "anyOf" in child);
    const credentialSchemaContainer =
      /^credentials?$/i.test(normalizedKey) &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.keys(child).every((childKey) => CREDENTIAL_SCHEMA_WRAPPER_KEYS.has(childKey)) &&
      child.schema !== null &&
      typeof child.schema === "object" &&
      ("type" in child.schema ||
        "$ref" in child.schema ||
        "allOf" in child.schema ||
        "oneOf" in child.schema);
    if (
      SENSITIVE_KEY.test(normalizedKey) &&
      child !== null &&
      child !== "" &&
      !schemaProperty &&
      !credentialSchemaContainer
    ) {
      throw new UnsafeFixtureValueError(`${path}.${key}`, "sensitive key");
    }
    if (typeof child === "string" && /^[\[{]/.test(child.trim())) {
      try {
        const parsed = JSON.parse(child);
        output[safeKey] = JSON.stringify(
          sanitizeJson(parsed, pseudonymizer, `${path}.${key}<json>`),
          null,
          2,
        );
        continue;
      } catch (error) {
        if (error instanceof UnsafeFixtureValueError) throw error;
      }
    }
    output[safeKey] =
      typeof child === "string"
        ? sanitizeString(child, key, `${path}.${key}`, pseudonymizer)
        : sanitizeJson(child, pseudonymizer, `${path}.${key}`);
  }
  return output;
}

/** Keep query variants while making their values safe and deterministic. */
export function sanitizeQuery(searchParams, pseudonymizer = new Pseudonymizer()) {
  const entries = [];
  for (const [key, value] of searchParams.entries()) {
    const normalizedKey = key.replace(/[-_]/g, "");
    if (SENSITIVE_QUERY_KEY.test(normalizedKey)) {
      throw new UnsafeFixtureValueError(`query.${key}`, "sensitive query parameter");
    }
    let safeValue = value;
    if (QUERY_ID_KEY.test(key) || INTERNAL_ID_RE.test(value)) {
      safeValue = pseudonymizer.alias("query", value);
    } else if (EMAIL_RE.test(value)) {
      safeValue = `${pseudonymizer.alias("person", value)}@example.invalid`;
    } else if (looksLikeUnknownSecret(value)) {
      throw new UnsafeFixtureValueError(`query.${key}`, "high-entropy query value");
    }
    entries.push([key, safeValue]);
  }
  return new URLSearchParams(entries).toString();
}

function canonicalQuery(query) {
  const entries = [...new URLSearchParams(query).entries()];
  entries.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
  );
  return new URLSearchParams(entries).toString();
}

export function captureSignature(capture) {
  return [
    capture.method.toLowerCase(),
    capture.path,
    canonicalQuery(capture.query),
    capture.scope.org ?? "",
    capture.scope.application ?? "",
  ].join("\u0000");
}

/** Dedupe repeated screen fetches but preserve query and org/app scope variants. */
export function dedupeCaptures(captures) {
  const bySignature = new Map();
  const conflicts = [];
  const conflictedSignatures = new Set();
  for (const capture of [...captures].sort((a, b) => a.order - b.order)) {
    const signature = captureSignature(capture);
    const existing = bySignature.get(signature);
    if (!existing) {
      bySignature.set(signature, { ...capture, screens: [capture.screen] });
      continue;
    }
    if (!existing.screens.includes(capture.screen)) existing.screens.push(capture.screen);
    if (
      JSON.stringify(existing.body) !== JSON.stringify(capture.body) &&
      !conflictedSignatures.has(signature)
    ) {
      conflictedSignatures.add(signature);
      conflicts.push({
        path: capture.path,
        method: capture.method,
        firstOrder: existing.order,
        nextOrder: capture.order,
      });
    }
  }
  return { captures: [...bySignature.values()], conflicts };
}

function identifierFor(capture, index) {
  const words = `${capture.method}-${capture.path}`
    .replace(/\{([^}]+)\}/g, "-$1-")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const pascal = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return `recorded${pascal}${String(index + 1).padStart(3, "0")}`;
}

function literal(value) {
  return JSON.stringify(value, null, 2);
}

/** Generate a review-only candidate file. It is deliberately not wired to handlers. */
export function generateCandidate(captures, { fixtureImport = "./fixtures" } = {}) {
  const lines = [
    "// SPDX-License-Identifier: Apache-2.0",
    "",
    "/**",
    " * GENERATED CANDIDATES. Review and promote useful shapes by hand.",
    " * This file is not imported by the lab and never replaces authored states.",
    " */",
    `import type { Json200 } from ${JSON.stringify(fixtureImport)};`,
    "",
  ];
  const metadata = [];

  captures.forEach((capture, index) => {
    const identifier = identifierFor(capture, index);
    lines.push(
      `export const ${identifier}: Json200<${JSON.stringify(capture.path)}, ${JSON.stringify(
        capture.method.toLowerCase(),
      )}> = ${literal(capture.body)};`,
      "",
    );
    metadata.push({
      fixture: identifier,
      order: capture.order,
      method: capture.method.toUpperCase(),
      path: capture.path,
      query: capture.query,
      scope: capture.scope,
      screens: capture.screens,
    });
  });

  lines.push(`export const recordedFixtureMetadata = ${literal(metadata)} as const;`, "");
  return lines.join("\n");
}

export function generateReport({ captures, specials, conflicts, unresolvedScreens }) {
  const lines = [
    "# Recorded lab fixture candidates",
    "",
    "> Generated from one nominal Tier 0 traversal. Shapes are captured; authored state variety is not.",
    "",
    `Typed JSON 200 candidates: ${captures.length}`,
    `Special or rejected responses: ${specials.length}`,
    `Conflicting repeated responses: ${conflicts.length}`,
    `Unresolved screens: ${unresolvedScreens.length}`,
    "",
    "## Typed candidates",
    "",
  ];
  if (captures.length === 0) lines.push("None.", "");
  for (const capture of captures) {
    const query = capture.query ? `?${capture.query}` : "";
    const scope = [capture.scope.org, capture.scope.application].filter(Boolean).join(" / ");
    lines.push(
      `- ${capture.order}. \`${capture.method.toUpperCase()} ${capture.path}${query}\`` +
        `${scope ? `, scope \`${scope}\`` : ""}, screens: ${capture.screens.join(", ")}`,
    );
  }
  lines.push("", "## Special and rejected responses", "");
  if (specials.length === 0) lines.push("None.", "");
  for (const special of specials) {
    lines.push(
      `- ${special.fatal ? "**BLOCKING** " : ""}${special.order}. \`${special.method.toUpperCase()} ${special.path}\`, ${special.reason}`,
    );
  }
  lines.push("", "## Repeated-response conflicts", "");
  if (conflicts.length === 0) lines.push("None.", "");
  for (const conflict of conflicts) {
    lines.push(
      `- \`${conflict.method.toUpperCase()} ${conflict.path}\`, orders ${conflict.firstOrder} and ${conflict.nextOrder}`,
    );
  }
  lines.push("", "## Unresolved screens", "");
  if (unresolvedScreens.length === 0) lines.push("None.", "");
  for (const screen of unresolvedScreens) lines.push(`- ${screen}`);
  lines.push("");
  return lines.join("\n");
}
