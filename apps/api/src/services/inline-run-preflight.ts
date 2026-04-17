// SPDX-License-Identifier: Apache-2.0

/**
 * Shared preflight for inline-run endpoints.
 *
 * Runs every validation that has no durable side effect:
 *   1. Manifest shape (AFPS + inline caps)
 *   2. providerProfiles body shape
 *   3. config + input against the manifest's own AJV schemas
 *   4. Provider profile resolution (reads DB, no writes)
 *   5. Agent readiness (prompt, skills, tools, provider deps, config)
 *
 * Two modes:
 *   - "fail-fast" (default) — throws on the first failing stage. Used by
 *     POST /api/runs/inline; running the pipeline with partial validation
 *     would be pointless, so early exit saves work.
 *   - "accumulate" — runs every stage that is independent of the previous
 *     one's output, collects ValidationFieldError entries from all of them,
 *     and throws a single `validation_failed` with every problem surfaced.
 *     Used by POST /api/runs/inline/validate, whose entire purpose is to let
 *     developers iterate on a manifest in one round-trip.
 *
 * Infrastructure errors (DB, Redis, Docker) always bubble up as-is — they
 * are never converted into ValidationFieldError entries. Only `ApiError`
 * instances raised by validation helpers are folded into the accumulator.
 *
 * Throws `ApiError` on any failure (same shape the routes already emit).
 */
import { z } from "zod";
import type { Actor } from "../lib/actor.ts";
import type { AgentManifest, ProviderProfileMap } from "../types/index.ts";
import {
  ApiError,
  internalError,
  validationFailed,
  zodIssuesToFieldErrors,
  type ValidationFieldError,
} from "../lib/errors.ts";
import { parsePathMessage } from "../lib/field-errors.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { logger } from "../lib/logger.ts";
import { validateConfig, validateInput } from "./schema.ts";
import { validateInlineManifest } from "./inline-manifest-validation.ts";
import { buildShadowLoadedPackage, generateShadowPackageId } from "./inline-run.ts";
import { getInlineRunLimits } from "./run-limits.ts";
import { resolveManifestProviders } from "../lib/manifest-utils.ts";
import { validateAgentReadiness, collectAgentReadinessErrors } from "./agent-readiness.ts";
import { resolveActorProfileContext, resolveProviderProfiles } from "./connection-profiles.ts";

export interface InlineRunBody {
  manifest?: unknown;
  prompt?: unknown;
  input?: Record<string, unknown>;
  config?: Record<string, unknown>;
  providerProfiles?: Record<string, string>;
  modelId?: string | null;
  proxyId?: string | null;
}

export interface InlineRunPreflightResult {
  manifest: AgentManifest;
  prompt: string;
  effectiveConfig: Record<string, unknown>;
  effectiveInput: Record<string, unknown> | null;
  providerProfiles: ProviderProfileMap;
  providerProfilesOverride: Record<string, string> | undefined;
  modelIdOverride: string | null;
  proxyIdOverride: string | null;
}

const providerProfilesSchema = z.record(z.string(), z.uuid()).optional();

type Mode = "fail-fast" | "accumulate";

export async function runInlinePreflight(params: {
  orgId: string;
  applicationId: string;
  actor: Actor | null;
  body: InlineRunBody;
  mode?: Mode;
}): Promise<InlineRunPreflightResult> {
  const { orgId, applicationId, actor, body, mode = "fail-fast" } = params;

  // In accumulate mode we gather problems from every independent stage and
  // throw once at the end. In fail-fast mode stages throw as soon as they
  // detect a problem. `push` is a pure accumulator; every throw site is
  // explicit so the caller sees which stage raised and with which code/title.
  const accumulated: ValidationFieldError[] = [];
  const push = (errs: ValidationFieldError[]): void => {
    if (errs.length > 0) accumulated.push(...errs);
  };

  // ----- 1. Manifest shape -----
  const validated = validateInlineManifest({
    manifest: body.manifest,
    prompt: body.prompt,
    limits: getInlineRunLimits(),
  });
  if (!validated.valid) {
    const entries = validated.errors.map((e) => toFieldError(e, "invalid_inline_manifest"));
    if (mode === "fail-fast") {
      throw new ApiError({
        status: 400,
        code: "invalid_inline_manifest",
        title: "Invalid Inline Manifest",
        detail: validated.errors.join("; "),
        errors: entries,
      });
    }
    push(entries);
  }

  // A parsed manifest is only available when structural validation passed.
  // Later stages that strictly need it (AJV config/input schemas, readiness)
  // are gated on this in accumulate mode; fail-fast has already thrown.
  const manifest = validated.valid ? (validated.manifest as AgentManifest) : undefined;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";

  // ----- 2. Body-field validation -----
  const providerProfilesParsed = providerProfilesSchema.safeParse(body.providerProfiles);
  if (!providerProfilesParsed.success) {
    const entries = zodIssuesToFieldErrors(providerProfilesParsed.error.issues, "providerProfiles");
    if (mode === "fail-fast") throw validationFailed(entries);
    push(entries);
  }
  const providerProfilesOverride = providerProfilesParsed.success
    ? providerProfilesParsed.data
    : undefined;
  const modelIdOverride = body.modelId ?? null;
  const proxyIdOverride = body.proxyId ?? null;

  // ----- 3. config + input against manifest schemas (AJV) -----
  const effectiveConfig =
    body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : {};
  const effectiveInput =
    body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : null;

  if (manifest) {
    const configSchema = manifest.config?.schema;
    if (configSchema) {
      const cv = validateConfig(effectiveConfig, asJSONSchemaObject(configSchema));
      if (!cv.valid) {
        const entries: ValidationFieldError[] = cv.errors.map((e) => ({
          field: e.field ? `config.${e.field}` : "config",
          code: "invalid_config",
          title: "Invalid Config",
          message: e.message,
        }));
        if (mode === "fail-fast") throw validationFailed(entries);
        push(entries);
      }
    }

    const inputSchema = manifest.input?.schema;
    if (inputSchema) {
      const iv = validateInput(effectiveInput ?? undefined, asJSONSchemaObject(inputSchema));
      if (!iv.valid) {
        const entries: ValidationFieldError[] = iv.errors.map((e) => ({
          field: e.field ? `input.${e.field}` : "input",
          code: "invalid_input",
          title: "Invalid Input",
          message: e.message,
        }));
        if (mode === "fail-fast") throw validationFailed(entries);
        push(entries);
      }
    }
  }

  // ----- 4. Provider profile resolution + readiness -----
  // These stages require a parsed manifest. In accumulate mode, skip cleanly
  // when structural validation failed — the manifest-shape errors already
  // explain why. Fail-fast has thrown long before reaching here.
  let providerProfiles: ProviderProfileMap = {};
  if (manifest) {
    const probeAgent = buildShadowLoadedPackage(generateShadowPackageId(), manifest, prompt);
    const { defaultUserProfileId } = await resolveActorProfileContext(actor, probeAgent.id);

    try {
      providerProfiles = await resolveProviderProfiles(
        resolveManifestProviders(manifest),
        defaultUserProfileId,
        providerProfilesOverride,
        null,
        applicationId,
      );
    } catch (err) {
      // Only ApiError is a validation signal. Everything else (DB outage,
      // network timeout, programmer error) must bubble as-is so the error
      // handler emits a 5xx and alerting fires.
      if (mode === "fail-fast" || !(err instanceof ApiError)) throw err;
      push(apiErrorToFields(err, "providers"));
      providerProfiles = {};
    }

    // In accumulate mode, stage 3 already validated config via AJV against
    // the manifest schema — tell readiness to skip its config check so the
    // same field never appears twice in `errors[]`. Prompt is NOT skipped:
    // stage 1's structural check only validates prompt type and byte size,
    // not emptiness, so readiness remains the single source for the
    // `empty_prompt` signal.
    if (mode === "fail-fast") {
      await validateAgentReadiness({
        agent: probeAgent,
        providerProfiles,
        orgId,
        config: effectiveConfig,
        applicationId,
      });
    } else {
      push(
        await collectAgentReadinessErrors({
          agent: probeAgent,
          providerProfiles,
          orgId,
          config: effectiveConfig,
          applicationId,
          skip: { config: true },
        }),
      );
    }
  }

  if (mode === "accumulate" && accumulated.length > 0) {
    throw validationFailed(accumulated);
  }

  // Guaranteed non-null: accumulate mode throws above when manifest is
  // missing (structural errors were collected), and fail-fast throws at
  // stage 1 before reaching this point. If we ever land here it means a
  // structural failure produced zero error messages — a real bug. Log it
  // so the regression is diagnosable rather than masked behind a 500.
  if (!manifest) {
    logger.error("preflight invariant broken: reached return without a parsed manifest", {
      orgId,
      applicationId,
      mode,
      accumulated: accumulated.length,
    });
    throw internalError();
  }

  return {
    manifest,
    prompt,
    effectiveConfig,
    effectiveInput,
    providerProfiles,
    providerProfilesOverride,
    modelIdOverride,
    proxyIdOverride,
  };
}

/**
 * Parse an inline-manifest error string into a field entry. `validateInlineManifest`
 * already prefixes paths with `manifest.`, so no extra prefix is needed here.
 */
function toFieldError(raw: string, code: string): ValidationFieldError {
  return parsePathMessage(raw, { code, title: "Invalid Inline Manifest" });
}

/**
 * Fold a caught ApiError into one or more ValidationFieldError entries.
 *
 * If the caught error already carries a populated `errors[]` (e.g. a nested
 * helper that aggregates multiple problems), we forward those entries as-is
 * so we don't collapse rich detail into a single line. Otherwise we synth a
 * single entry from `param` / `code` / `title` / `message`.
 *
 * The runtime `instanceof` guard re-throws any non-ApiError — infrastructure
 * failures (DB, Redis, Docker) must surface as 5xx, never as a 400
 * `validation_failed`. Call sites check the same invariant before calling
 * here; the guard is belt-and-suspenders for future callers.
 */
function apiErrorToFields(err: unknown, fallbackField: string): ValidationFieldError[] {
  if (!(err instanceof ApiError)) throw err;
  if (err.fieldErrors && err.fieldErrors.length > 0) return err.fieldErrors;
  return [
    {
      field: err.param ?? fallbackField,
      code: err.code,
      title: err.title,
      message: err.message,
    },
  ];
}
