// SPDX-License-Identifier: Apache-2.0

/**
 * Model resolution — ported from the appstrate-chat satellite (lib/models.ts).
 *
 * The chat owns no LLM key. It lists the org's configured models
 * (`GET /api/models`) and picks the row the turn binds to; the binding itself
 * is built by `pi-chat/model-binding.ts`. For an API-key model that binding
 * points the engine at the platform **llm-proxy** (real provider key injected
 * server-side); for an OAuth subscription it points at the provider's own base
 * URL with the access token held in memory. Usage is metered server-side on
 * both paths. The only change from the satellite: instead of an OAuth inference
 * token against a remote instance, we forward the caller's own headers on a
 * loopback request (see self.ts).
 */

import { badGateway, invalidRequest } from "@appstrate/core/api-errors";
import { CHAT_USABLE_FAMILIES } from "./chat-families.ts";
import { isModelLive } from "./model-liveness.ts";
import { logger } from "./logger.ts";
import type { ModelGenerationCapabilities } from "@appstrate/core/model-generation";
import type { ModelCost } from "@appstrate/core/module";

export interface OrgModel {
  id: string;
  modelId: string;
  /** Provider/proxy family, from the model's `apiShape`, e.g. `openai-completions`. */
  apiShape: string;
  /** Credential provider id — distinguishes claude-code (subscription) from anthropic (api key). */
  providerId?: string;
  label?: string;
  enabled?: boolean;
  /** snake_case to match the `/api/models` wire field — camelCase silently never matches. */
  is_default?: boolean;
  /**
   * The model's credential can no longer serve inference (revoked OAuth refresh
   * token, or a stored blob that no longer decrypts). Same snake_case wire
   * convention as {@link is_default}.
   */
  needs_reconnection?: boolean;
  generation?: ModelGenerationCapabilities | null;
  input?: string[] | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  reasoning?: boolean | null;
  cost?: ModelCost | null;
}

export async function listModels(
  origin: string,
  headers: Record<string, string>,
  platformFetch: typeof fetch,
): Promise<OrgModel[]> {
  const res = await platformFetch(`${origin}/api/models`, { headers });
  if (!res.ok) throw badGateway(`/api/models returned ${res.status}`);
  // `/api/models` answers with the Stripe-canonical list envelope
  // `{ object: "list", data, hasMore }` (apps/api `listResponse`, and the
  // OpenAPI schema declares `data` required) — `data` is the only shape.
  const body = (await res.json()) as { data?: OrgModel[] };
  if (!Array.isArray(body.data)) {
    logger.warn("/api/models returned an unexpected shape (no data array)");
    return [];
  }
  return body.data;
}

export function pickModel(models: OrgModel[], modelId?: string): OrgModel {
  // `enabled` is opt-out: a missing flag counts as enabled.
  const usable = models.filter((m) => m.enabled !== false && CHAT_USABLE_FAMILIES.has(m.apiShape));
  if (usable.length === 0 && models.some((m) => m.enabled !== false)) {
    throw invalidRequest(
      "No chat-usable model is configured. Connect an API-key model (Anthropic, OpenAI, Mistral) or a Claude Code subscription in Settings → Models.",
    );
  }
  // Liveness is the second gate, on top of enabled + chat-usable family:
  // without it a gone-dead org default would be picked and fail deep inside
  // the provider with an opaque error. The picker (`ui/`) renders those rows
  // instead of hiding them — same predicate, different answer to give.
  const pool = usable.filter(isModelLive);
  const chosen = modelId
    ? pool.find((m) => m.id === modelId || m.modelId === modelId)
    : (pool.find((m) => m.is_default) ?? pool[0]);
  if (!chosen) {
    // A dead model is one the user HAS: neither "configure a model" (the
    // family fallback above) nor "not an enabled model" (below) names the fix.
    // Covers both the explicitly pinned dead id and the all-models-dead case,
    // where `usable` is non-empty but `pool` is not.
    const dead = modelId
      ? usable.some((m) => m.id === modelId || m.modelId === modelId)
      : usable.length > 0;
    if (dead) {
      throw invalidRequest(
        "The selected model can no longer serve inference: its connection must be re-established in Settings → Models.",
      );
    }
    throw invalidRequest(
      modelId
        ? `Model "${modelId}" is not an enabled model on this instance.`
        : "No enabled model is configured (Settings → Models).",
    );
  }
  return chosen;
}
