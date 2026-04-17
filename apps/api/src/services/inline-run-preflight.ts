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
  // throw once at the end. The shape of individual entries matches every
  // other `validation_failed` response emitted by the platform.
  const accumulated: ValidationFieldError[] = [];
  const collect = (errs: ValidationFieldError[], throwCode?: string): void => {
    if (errs.length === 0) return;
    if (mode === "fail-fast") {
      throw new ApiError({
        status: 400,
        code: throwCode ?? "validation_failed",
        title: throwCode ? codeToTitle(throwCode) : "Validation Failed",
        detail: `${errs[0]!.field}: ${errs[0]!.message}`,
        errors: errs,
      });
    }
    accumulated.push(...errs);
  };

  // ----- 1. Manifest shape -----
  const validated = validateInlineManifest({
    manifest: body.manifest,
    prompt: body.prompt,
    limits: getInlineRunLimits(),
  });
  if (!validated.valid) {
    collect(
      validated.errors.map((e) => toFieldError(e, "invalid_inline_manifest")),
      "invalid_inline_manifest",
    );
  }

  // A parsed manifest is only available when structural validation passed.
  // Later stages that strictly need it (AJV config/input schemas, readiness)
  // are gated on this in accumulate mode; fail-fast has already thrown.
  const manifest = validated.valid ? (validated.manifest as AgentManifest) : undefined;
  const prompt = typeof body.prompt === "string" ? body.prompt : "";

  // ----- 2. Body-field validation -----
  const providerProfilesParsed = providerProfilesSchema.safeParse(body.providerProfiles);
  if (!providerProfilesParsed.success) {
    collect(zodIssuesToFieldErrors(providerProfilesParsed.error.issues, "providerProfiles"));
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
        collect(
          cv.errors.map((e) => ({
            field: e.field ? `config.${e.field}` : "config",
            code: "invalid_config",
            message: e.message,
          })),
        );
      }
    }

    const inputSchema = manifest.input?.schema;
    if (inputSchema) {
      const iv = validateInput(effectiveInput ?? undefined, asJSONSchemaObject(inputSchema));
      if (!iv.valid) {
        collect(
          iv.errors.map((e) => ({
            field: e.field ? `input.${e.field}` : "input",
            code: "invalid_input",
            message: e.message,
          })),
        );
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
      accumulated.push(apiErrorToField(err, "providers"));
      providerProfiles = {};
    }

    if (mode === "fail-fast") {
      await validateAgentReadiness({
        agent: probeAgent,
        providerProfiles,
        orgId,
        config: effectiveConfig,
        applicationId,
      });
    } else {
      accumulated.push(
        ...(await collectAgentReadinessErrors({
          agent: probeAgent,
          providerProfiles,
          orgId,
          config: effectiveConfig,
          applicationId,
        })),
      );
    }
  }

  if (mode === "accumulate" && accumulated.length > 0) {
    throw validationFailed(accumulated);
  }

  // Guaranteed non-null: accumulate mode throws above when manifest is
  // missing (structural errors were collected), and fail-fast throws at
  // stage 1 before reaching this point.
  if (!manifest) {
    throw new Error("runInlinePreflight: reached success path without a manifest");
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
  if (idx === -1) return { field: "manifest", code, message: raw };
  return { field: raw.slice(0, idx), code, message: raw.slice(idx + 2) };
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
    message: err.message,
  };
}

function codeToTitle(code: string): string {
  return code
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}
