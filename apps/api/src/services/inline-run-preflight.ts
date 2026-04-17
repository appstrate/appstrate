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
import { asJSONSchemaObject } from "@appstrate/core/form";
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
      push([apiErrorToField(err, "providers")]);
      providerProfiles = {};
    }

    // In accumulate mode, stages 1–3 already covered prompt (via the manifest
    // structural check) and config (via AJV at stage 3). Tell readiness to
    // skip those so the same field never appears twice in `errors[]`.
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
          skip: { prompt: true, config: true },
        }),
      );
    }
  }

  if (mode === "accumulate" && accumulated.length > 0) {
    throw validationFailed(accumulated);
  }

  // Guaranteed non-null: accumulate mode throws above when manifest is
  // missing (structural errors were collected), and fail-fast throws at
  // stage 1 before reaching this point. The internalError() serialises as
  // a proper 500 RFC 9457 response if the invariant ever breaks.
  if (!manifest) {
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

/** Parse an inline-manifest error string (`"path: message"`) into a field entry. */
function toFieldError(raw: string, code: string): ValidationFieldError {
  const idx = raw.indexOf(": ");
  if (idx === -1)
    return { field: "manifest", code, title: "Invalid Inline Manifest", message: raw };
  return {
    field: raw.slice(0, idx),
    code,
    title: "Invalid Inline Manifest",
    message: raw.slice(idx + 2),
  };
}

/**
 * Fold a caught ApiError into a ValidationFieldError.
 *
 * Callers MUST have already verified `err instanceof ApiError` — non-ApiError
 * instances represent infrastructure failures and should never reach here.
 */
function apiErrorToField(err: ApiError, fallbackField: string): ValidationFieldError {
  return {
    field: err.param ?? fallbackField,
    code: err.code,
    title: err.title,
    message: err.message,
  };
}
