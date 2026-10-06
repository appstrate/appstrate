// SPDX-License-Identifier: Apache-2.0

/**
 * Refusal codes ↔ locale files.
 *
 * What this suite can see of the API's codes, and no more:
 *   - the literal ones — `code: "…"`, `conflict("…")`, `gone("…")`,
 *     `new GithubImportError("…")`, `new PackageZipError("…")` — read from the API SOURCE, plus
 *     the `error: "UPPER"` of the modules that build a connection-test result;
 *   - the four closed unions an error class or a validator forwards, each written out below as a
 *     `Record<Union, true>` so a member added to the type fails the typecheck here;
 *   - Better Auth's, checked against the installed package's own table.
 * A code assembled any other way (a ternary, a lookup table, a third-party module) is invisible
 * unless it is named in `EMITTED_OUT_OF_SIGHT`: the guard narrows the gap, it does not close it.
 *
 * Forward (strict): a visible code with no sentence fails, unless `NOT_SURFACED` exempts it with
 * the reason. Reverse (best-effort, bounded by what is visible): a sentence or a mapped key that
 * matches no known code fails.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BASE_ERROR_CODES } from "better-auth";
import type { CompanionViolationReason } from "@appstrate/afps-shared/companion-files";
import type { FieldErrorCode } from "@appstrate/core/api-errors";
import type { ModelGenerationErrorCode } from "@appstrate/core/model-generation";
import type { PackageFileWriteErrorCode } from "@appstrate/core/package-file-operations";
import { RUNTIME_TOOL_CATALOG } from "@appstrate/core/runtime-tools-catalog";
import i18n, { i18nReady } from "../../i18n.ts";
import { toApiError } from "../../api/client.ts";
import { ApiError } from "../../api/errors.ts";
import { errorField, errorMessage, refusalMessage, REFUSAL_ERROR_KEYS } from "../mutation-error.ts";
import fr from "../../locales/fr/common.json";
import en from "../../locales/en/common.json";
import agentsFr from "../../locales/fr/agents.json";
import agentsEn from "../../locales/en/agents.json";

await i18nReady;

// The i18n instance is shared by every suite of the run, and they expect French.
afterAll(async () => {
  await i18n.changeLanguage("fr");
});

const REPO_ROOT = join(import.meta.dir, "../../../../..");

/** Where a problem `code` can be written. Tests, OpenAPI prose and React code emit none. */
const SOURCES = [
  "apps/api/src/**/*.ts",
  "packages/core/src/**/*.ts",
  "packages/db/src/**/*.ts",
  "packages/connect/src/**/*.ts",
  "packages/module-*/src/**/*.ts",
];
const NOT_A_SOURCE = /\/test\/|\.test\.ts$|\/openapi\/|\/openapi\.ts$|\/ui\//;

/** Literal codes, wherever a problem can be raised. */
const CODE_PATTERNS = [
  /\bcode:\s*"([a-z][a-z0-9_]*)"/g,
  // Either case: two `gone(…)` codes are UPPER_SNAKE on the wire.
  /\b(?:conflict|gone)\(\s*"([A-Za-z][A-Za-z0-9_]*)"/g,
  // The import routes forward these classes' codes as the problem code.
  /\bnew (?:GithubImportError|PackageZipError)\(\s*"([A-Z][A-Z_]*)"/g,
];

/**
 * `TestResult.error`: the UPPER_SNAKE outcome of a connection test. Read only where a
 * `TestResult` is built — the same `error: "X"` shape elsewhere is an internal result tag
 * (`VERSION_NOT_HIGHER`, …) that never reaches the wire as a code.
 */
const TEST_RESULT_PATTERN = /\berror:\s*"([A-Z][A-Z_]*)"/g;
const BUILDS_TEST_RESULTS =
  /^apps\/api\/src\/(lib\/network-error|services\/(org-models|org-proxies|model-providers\/)|routes\/(models|proxies|model-provider-credentials))/;

/** Every member of a closed union: a missing or a stale one is a type error. */
const membersOf = <T extends string>(members: Record<T, true>): string[] => Object.keys(members);

/** Codes a validator or an error class forwards as the problem (or item) code. */
const FORWARDED = [
  ...membersOf<FieldErrorCode>({
    required: true,
    invalid_type: true,
    invalid_format: true,
    out_of_range: true,
    unknown_field: true,
    invalid_value: true,
    invalid_union: true,
    invalid_key: true,
    invalid_element: true,
    invalid_request: true,
  }),
  ...membersOf<PackageFileWriteErrorCode>({
    invalid_bundle: true,
    invalid_path: true,
    reserved_entry: true,
    content_entry_immovable: true,
    not_found: true,
    path_conflict: true,
    file_too_large: true,
    tree_too_large: true,
  }),
  ...membersOf<ModelGenerationErrorCode>({
    temperature_unsupported: true,
    reasoning_unsupported: true,
    reasoning_level_unsupported: true,
    temperature_with_reasoning_unsupported: true,
  }),
  ...membersOf<CompanionViolationReason>({
    AGENT_MISSING_PROMPT: true,
    AGENT_EMPTY_PROMPT: true,
    SKILL_MISSING_SKILL_MD: true,
    SKILL_INVALID_FRONTMATTER: true,
    SKILL_MISSING_FRONTMATTER_NAME: true,
    SKILL_INVALID_FRONTMATTER_NAME: true,
    SKILL_MISSING_FRONTMATTER_DESCRIPTION: true,
    SKILL_INVALID_FRONTMATTER_DESCRIPTION: true,
    MCP_SERVER_MISSING_ENTRY_POINT: true,
  }),
];

/** Better Auth's own codes the sign-in, sign-up, password and account forms can meet. */
const BETTER_AUTH_CODES = [
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_PASSWORD",
  "INVALID_EMAIL",
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  "EMAIL_NOT_VERIFIED",
  "PASSWORD_TOO_SHORT",
  "PASSWORD_TOO_LONG",
  "USER_NOT_FOUND",
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "SESSION_EXPIRED",
  "FAILED_TO_UNLINK_LAST_ACCOUNT",
  "SOCIAL_ACCOUNT_ALREADY_LINKED",
  "CREDENTIAL_ACCOUNT_NOT_FOUND",
];

/** Codes no literal and no union can show: each is picked by a ternary. */
const EMITTED_OUT_OF_SIGHT = [
  // The two `beforeUsage` refusals of `@appstrate/module-ee`.
  "quota_exceeded",
  "subscription_blocked",
  // `parsePackageZip`'s companion-file refusal (`@appstrate/core/zip`).
  "missing_content",
  "invalid_content",
];

/** Codes that never reach a sentence in the dashboard, by reason. */
const NOT_SURFACED = new Set([
  // Not a problem code: a Zod issue code, and the `/health` readiness states.
  "custom",
  "starting",
  "shutting_down",
  // RFC 8628 device-flow / token-endpoint answers, read by the CLI.
  "access_denied",
  "authorization_pending",
  "expired_token",
  "invalid_grant",
  "server_error",
  "slow_down",
  // Runner, sidecar and credential-proxy protocol: the caller is a container, not a person.
  "connect_run_no_refresh",
  "connection_not_in_run",
  "integration_auth_undeclared",
  "invalid_signature",
  "invalid_timestamp",
  "message_replayed",
  "missing_signature_headers",
  "run_agent_deleted",
  "run_definition_gone",
  "run_not_running",
  "run_sink_closed",
  "run_sink_expired",
  "timestamp_out_of_tolerance",
  "usage_context_required",
  // Request headers only an API client sets (Idempotency-Key, Appstrate-Version, Appstrate-User).
  "header_not_allowed",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_not_supported",
  "invalid_api_version",
  "invalid_end_user",
  "invalid_end_user_id",
  "invalid_idempotency_key",
  "unsupported_api_version",
  // Answered by the server-rendered OIDC pages, which carry their own copy.
  "login_link_expired",
  "oidc_realm_unresolved",
  "signup_configuration_invalid",
  // A refused role preview ends the preview with its own copy (`viewAs.stopped.<code>`).
  "invalid_view_as",
  "view_as_forbidden",
  "view_as_not_found",
  "view_as_unsupported",
]);

async function literalCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  for (const pattern of SOURCES) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
      if (NOT_A_SOURCE.test(file)) continue;
      const source = await Bun.file(join(REPO_ROOT, file)).text();
      const patterns = BUILDS_TEST_RESULTS.test(file)
        ? [...CODE_PATTERNS, TEST_RESULT_PATTERN]
        : CODE_PATTERNS;
      for (const re of patterns) {
        for (const match of source.matchAll(re)) codes.add(match[1]!.toLowerCase());
      }
    }
  }
  return codes;
}

const literal = await literalCodes();
const emitted = new Set([
  ...literal,
  ...[...FORWARDED, ...BETTER_AUTH_CODES, ...EMITTED_OUT_OF_SIGHT].map((c) => c.toLowerCase()),
]);

/** A problem body as the client receives it, turned into the error the SPA handles. */
async function problem(body: Record<string, unknown>): Promise<Error> {
  return toApiError(
    new Response(JSON.stringify(body), {
      status: typeof body.status === "number" ? body.status : 400,
      headers: { "content-type": "application/problem+json" },
    }),
  );
}

describe("API refusal codes ↔ locale files", () => {
  it("finds the API's codes (the scan is not silently empty)", () => {
    expect(literal.size).toBeGreaterThan(150);
    expect(literal.has("slug_taken")).toBe(true);
    expect(literal.has("space_has_active_runs")).toBe(true);
    expect(literal.has("repo_too_large")).toBe(true);
  });

  // French only: `fr` is the fallback language, so an English pass would resolve the same keys;
  // the parity test below is what holds `en`.
  it("translates every surfaced code", async () => {
    await i18n.changeLanguage("fr");
    const untranslated = [...emitted]
      .filter((code) => !NOT_SURFACED.has(code))
      .filter((code) => refusalMessage({ code }) === null)
      .sort();
    expect(untranslated).toEqual([]);
  });

  it("maps only emitted codes to sentences the agents bundle has", () => {
    const mapped = Object.entries(REFUSAL_ERROR_KEYS);
    expect(mapped.filter(([code]) => !emitted.has(code)).map(([code]) => code)).toEqual([]);
    expect(mapped.filter(([, key]) => !(key in agentsFr)).map(([, key]) => key)).toEqual([]);
  });

  it("keeps no exemption for a code the API stopped emitting", () => {
    expect([...NOT_SURFACED].filter((code) => !emitted.has(code))).toEqual([]);
  });

  it("keeps no sentence for a code nothing emits", () => {
    const orphans = Object.keys(fr)
      .filter((key) => key.startsWith("apiError."))
      // `<code>_nofield` is the same code's sentence for a refusal that names no field.
      .map((key) => key.slice("apiError.".length).replace(/_nofield$/, ""))
      .filter((code) => !emitted.has(code))
      .sort();
    expect(orphans).toEqual([]);
  });

  it("lists only Better Auth codes the installed package defines", () => {
    const defined = new Set(Object.keys(BASE_ERROR_CODES));
    expect(BETTER_AUTH_CODES.filter((code) => !defined.has(code))).toEqual([]);
  });

  it("carries the same apiError.* keys in both locales", () => {
    const keys = (bundle: Record<string, string>) =>
      Object.keys(bundle)
        .filter((k) => k.startsWith("apiError."))
        .sort();
    expect(keys(en)).toEqual(keys(fr));
  });
});

describe("runtime tool descriptions", () => {
  it("exist in both locales for every tool of the catalog", () => {
    const missing = RUNTIME_TOOL_CATALOG.flatMap((tool) =>
      [agentsFr, agentsEn]
        .filter((bundle) => !(`editor.runtimeTool.${tool.id}` in bundle))
        .map(() => tool.id),
    );
    expect(missing).toEqual([]);
  });
});

describe("errorMessage", () => {
  it("names a refusal by its code", async () => {
    await i18n.changeLanguage("fr");
    const err = await problem({ code: "slug_taken", detail: "Slug 'acme' is already in use" });
    expect(errorMessage(err)).toBe(fr["apiError.slug_taken"]);
  });

  it("keeps the server detail behind the lead of a catch-all code", async () => {
    await i18n.changeLanguage("fr");
    const err = await problem({
      code: "forbidden",
      status: 403,
      detail: "Insufficient permissions: members:invite required",
    });
    expect(errorMessage(err)).toBe(
      "Action refusée : Insufficient permissions: members:invite required",
    );
  });

  it("names the field of a validation failure, keeps its reason and counts the rest", async () => {
    await i18n.changeLanguage("fr");
    const err = await problem({
      code: "validation_failed",
      detail: "manifest.source.remote.url: Invalid URL (+2 more)",
      errors: [
        { field: "manifest.source.remote.url", code: "invalid_format", message: "Invalid URL" },
        { field: "manifest.auths", code: "invalid_value", message: "MUST declare one auth" },
        { field: "manifest.name", code: "required", message: "Required" },
      ],
    });
    expect(errorMessage(err)).toBe(
      "Champ « manifest.source.remote.url » : format invalide (Invalid URL) (+2 autres erreurs)",
    );
    expect(errorField(err)).toBe("manifest.source.remote.url");
  });

  it("drops the field clause of a code emitted without a field", async () => {
    await i18n.changeLanguage("fr");
    const err = await problem({ code: "invalid_input", detail: "age: must be number" });
    expect(errorMessage(err)).toBe("Paramètres invalides : age: must be number");
    expect(errorMessage(err)).not.toContain("«");
  });

  it("shows a launch parameter under the name the user typed, without the wire prefix", async () => {
    await i18n.changeLanguage("fr");
    const err = await problem({
      code: "validation_failed",
      detail: "input.age: must be number",
      errors: [{ field: "input.age", code: "invalid_input", message: "must be number" }],
    });
    expect(errorMessage(err)).toBe("Paramètres invalides, champ « age » : must be number");
  });

  it("falls back to the generic sentence for a failure that says nothing", async () => {
    await i18n.changeLanguage("fr");
    expect(errorMessage(new ApiError("", "", 0))).toBe(fr["error.generic"]);
    expect(errorMessage(new Error(""))).toBe(fr["error.generic"]);
  });

  it("keeps the server's own summary when the item code has no sentence", async () => {
    await i18n.changeLanguage("fr");
    const detail = "content: something only a newer server knows (+1 more)";
    const err = await problem({
      code: "validation_failed",
      detail,
      errors: [{ field: "content", code: "code_from_a_newer_server", message: "…" }],
    });
    expect(errorMessage(err)).toBe(detail);
  });

  it("quotes the checker's rule for a SKILL.md refusal, wherever it surfaces", async () => {
    await i18n.changeLanguage("fr");
    const err = await problem({
      code: "validation_failed",
      detail: "content: Map keys must be unique",
      errors: [
        { field: "content", code: "skill_invalid_frontmatter", message: "Map keys must be unique" },
      ],
    });
    expect(errorMessage(err)).toContain("Map keys must be unique");
    expect(errorMessage(err)).not.toContain("{{detail}}");
  });

  it("reads Better Auth's upper-case codes from the same table", async () => {
    await i18n.changeLanguage("fr");
    const err = new ApiError("INVALID_EMAIL_OR_PASSWORD", "Invalid email or password", 401);
    expect(errorMessage(err)).toBe(fr["apiError.invalid_email_or_password"]);
  });

  it("leaves a failure that names no known code as it is, without a prefix", async () => {
    await i18n.changeLanguage("fr");
    expect(errorMessage(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(
      errorMessage(await problem({ code: "code_from_an_unknown_module", detail: "Nope" })),
    ).toBe("Nope");
  });
});
