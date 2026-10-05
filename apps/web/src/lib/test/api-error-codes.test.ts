// SPDX-License-Identifier: Apache-2.0

/**
 * Every refusal `code` the API can put in a problem body (top-level, or an `errors[]` item) has
 * a sentence in both locales — so the SPA never falls back to the server's English `detail`.
 *
 * The codes are read from the API SOURCE, not from a list kept here: a new
 * `code: "…"` / `conflict("…")` with no `apiError.<code>` in `locales/{fr,en}/common.json` fails
 * this suite. A code no dashboard user can meet is exempted in `NOT_SURFACED`, with the reason.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import i18n, { i18nReady } from "../../i18n.ts";
import { ApiError } from "../../api/errors.ts";
import { errorMessage, refusalMessage } from "../mutation-error.ts";
import fr from "../../locales/fr/common.json";
import en from "../../locales/en/common.json";

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

const CODE_PATTERNS = [
  /\bcode:\s*"([a-z][a-z0-9_]*)"/g,
  /\b(?:conflict|gone)\(\s*"([a-z][a-z0-9_]*)"/g,
  // The UPPER_SNAKE outcome of a connection test or a version check (`TestResult.error`, …).
  /\berror:\s*"([A-Z][A-Z_]*)"/g,
];

/** Codes the scan cannot see because they are not written as a literal next to `code:`. */
const EMITTED_OUT_OF_SIGHT = [
  // The two `beforeUsage` refusals of `@appstrate/module-ee`, picked by a ternary.
  "quota_exceeded",
  "subscription_blocked",
  // `FieldErrorCode` (`@appstrate/core/api-errors`): the closed set a Zod issue maps to.
  "required",
  "invalid_type",
  "invalid_format",
  "out_of_range",
  "unknown_field",
  "invalid_value",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  // Better Auth's own codes the sign-in, sign-up and password forms meet.
  "invalid_email_or_password",
  "invalid_password",
  "user_already_exists_use_another_email",
  "email_not_verified",
  "password_too_short",
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

async function emittedCodes(): Promise<Set<string>> {
  const codes = new Set(EMITTED_OUT_OF_SIGHT);
  for (const pattern of SOURCES) {
    for await (const file of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT })) {
      if (NOT_A_SOURCE.test(file)) continue;
      const source = await Bun.file(join(REPO_ROOT, file)).text();
      for (const re of CODE_PATTERNS) {
        for (const match of source.matchAll(re)) codes.add(match[1]!.toLowerCase());
      }
    }
  }
  return codes;
}

const emitted = await emittedCodes();

describe("API refusal codes ↔ locale files", () => {
  it("finds the API's codes (the scan is not silently empty)", () => {
    expect(emitted.size).toBeGreaterThan(150);
    expect(emitted.has("slug_taken")).toBe(true);
    expect(emitted.has("space_has_active_runs")).toBe(true);
  });

  for (const lng of ["fr", "en"] as const) {
    it(`translates every surfaced code in ${lng}`, async () => {
      await i18n.changeLanguage(lng);
      const untranslated = [...emitted]
        .filter((code) => !NOT_SURFACED.has(code))
        .filter((code) => refusalMessage({ code }) === null)
        .sort();
      expect(untranslated).toEqual([]);
    });
  }

  it("keeps no exemption for a code the API stopped emitting", () => {
    expect([...NOT_SURFACED].filter((code) => !emitted.has(code))).toEqual([]);
  });

  it("carries the same apiError.* keys in both locales", () => {
    const keys = (bundle: Record<string, string>) =>
      Object.keys(bundle)
        .filter((k) => k.startsWith("apiError."))
        .sort();
    expect(keys(en)).toEqual(keys(fr));
  });
});

describe("errorMessage", () => {
  it("names a refusal by its code, never by the server's English detail", async () => {
    await i18n.changeLanguage("fr");
    const err = new ApiError("slug_taken", "Slug 'acme' is already in use", 400);
    expect(errorMessage(err)).toBe(fr["apiError.slug_taken"]);
    expect(errorMessage(err)).not.toContain("already in use");
  });

  it("names the field of a validation failure from its first errors[] item", async () => {
    await i18n.changeLanguage("fr");
    const err = new ApiError("validation_failed", "manifest.source.remote.url: Invalid URL", 400, [
      { field: "manifest.source.remote.url", code: "invalid_format", message: "Invalid URL" },
    ] as unknown as Record<string, unknown>);
    const message = errorMessage(err);
    expect(message).toContain("manifest.source.remote.url");
    expect(message).not.toContain("Invalid URL");
  });

  it("reads Better Auth's upper-case codes from the same table", async () => {
    await i18n.changeLanguage("fr");
    const err = new ApiError("INVALID_EMAIL_OR_PASSWORD", "Invalid email or password", 401);
    expect(errorMessage(err)).toBe(fr["apiError.invalid_email_or_password"]);
  });

  it("falls back to the raw message only for a failure that names no known code", async () => {
    await i18n.changeLanguage("fr");
    expect(errorMessage(new Error("Failed to fetch"))).toBe("Erreur : Failed to fetch");
    expect(errorMessage(new ApiError("code_from_an_unknown_module", "Nope", 400))).toBe(
      "Erreur : Nope",
    );
  });
});
