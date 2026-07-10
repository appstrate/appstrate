// SPDX-License-Identifier: Apache-2.0

/**
 * Shared preflight for inline-run endpoints.
 *
 * Runs every validation that has no durable side effect:
 *   1. Manifest shape (AFPS + inline caps)
 *   2. input against the manifest's own AJV schema
 *   3. Agent readiness (prompt, skills, tools, config)
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
import type { Actor } from "../lib/actor.ts";
import type { AgentManifest } from "../types/index.ts";
import {
  ApiError,
  internalError,
  validationFailed,
  type ValidationFieldError,
} from "../lib/errors.ts";
import { parsePathMessage } from "../lib/field-errors.ts";
import { asJSONSchemaObject } from "@appstrate/core/form";
import { logger } from "../lib/logger.ts";
import { validateInput } from "./schema.ts";
import { validateInlineManifest } from "./inline-manifest-validation.ts";
import { buildShadowLoadedPackage, generateShadowPackageId } from "./inline-run.ts";
import { getInlineRunLimits } from "./run-limits.ts";
import { validateAgentReadiness, collectAgentReadinessErrors } from "./agent-readiness.ts";
import type { InlineRunBody } from "@appstrate/core/platform-types";

export type { InlineRunBody };

export interface InlineRunPreflightResult {
  manifest: AgentManifest;
  prompt: string;
  effectiveConfig: Record<string, unknown>;
  effectiveInput: Record<string, unknown> | null;
  modelIdOverride: string | null;
  proxyIdOverride: string | null;
}

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
  // Inline agents are ephemeral one-shots, never shown in a catalog, so the
  // AFPS-required `display_name` is pure ceremony here — a missing one is the
  // single most common cause of a needless trigger→retry round-trip for an LLM
  // assembling the manifest. Default it from the manifest `name` before
  // validation so callers never have to supply it. (`author` is already relaxed
  // to optional for local/inline manifests in `@appstrate/core/validation`.)
  const normalizedManifest = defaultInlineDisplayName(body.manifest);
  const validated = validateInlineManifest({
    manifest: normalizedManifest,
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

  const modelIdOverride = body.modelId ?? null;
  const proxyIdOverride = body.proxyId ?? null;

  // ----- 2. input against manifest schema (AJV) -----
  // config + prompt validation are delegated entirely to agent readiness
  // (stage 3) — the single source of truth for those two fields. Only
  // `input` is validated here, since readiness has no notion of run input.
  const effectiveConfig =
    body.config && typeof body.config === "object" && !Array.isArray(body.config)
      ? (body.config as Record<string, unknown>)
      : {};
  const effectiveInput =
    body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? (body.input as Record<string, unknown>)
      : null;

  if (manifest) {
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

  // ----- 3. Agent readiness -----
  // This stage requires a parsed manifest. In accumulate mode, skip cleanly
  // when structural validation failed — the manifest-shape errors already
  // explain why. Fail-fast has thrown long before reaching here.
  if (manifest) {
    const probeAgent = buildShadowLoadedPackage(generateShadowPackageId(), manifest, prompt);

    // Readiness is the single source of truth for both config (AJV against
    // the manifest schema) and prompt emptiness — stage 1's structural check
    // only covers prompt type and byte size, not emptiness, and stage 2 no
    // longer touches config. Fail-fast throws the first readiness error;
    // accumulate folds every readiness entry into the shared accumulator.
    if (mode === "fail-fast") {
      await validateAgentReadiness({
        agent: probeAgent,
        orgId,
        config: effectiveConfig,
        applicationId,
        actor,
      });
    } else {
      push(
        await collectAgentReadinessErrors({
          agent: probeAgent,
          orgId,
          config: effectiveConfig,
          applicationId,
          actor,
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
 * Return a shallow copy of an inline manifest with `display_name` filled from
 * `name` when it is absent or blank. Non-object inputs pass through untouched so
 * the downstream shape validation still reports them. Pure (no mutation of the
 * caller's object) so the original request body stays intact.
 */
function defaultInlineDisplayName(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return manifest;
  const m = manifest as Record<string, unknown>;
  const current = typeof m.display_name === "string" ? m.display_name.trim() : "";
  if (current) return manifest;
  const name = typeof m.name === "string" ? m.name : "";
  // Strip a leading `@scope/` for a friendlier label; fall back to a constant.
  const label = name.replace(/^@[^/]+\//, "").trim() || "Inline agent";
  return { ...m, display_name: label };
}
