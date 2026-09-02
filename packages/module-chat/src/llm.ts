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
import { createCache } from "@appstrate/core/cache";
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

/**
 * Space-scoped operations (agents, runs, …) need a space context. A
 * session carries none by default, so resolve the org's default space
 * and forward it as `X-Space-Id` on the MCP request. Cached per org —
 * the default space rarely changes, but it CAN (an admin re-points it), so
 * an entry expires after {@link SPACE_CACHE_TTL_MS} and the next turn
 * re-reads. Without the expiry a process kept routing every turn's MCP
 * calls at the old space until restart.
 */
export const SPACE_CACHE_TTL_MS = 5 * 60_000;

// Only RESOLVED ids are cached — never a miss (the `store` predicate below). A
// miss (transient failure OR an empty 200) is left uncached so the next turn
// retries: an empty `/api/spaces` is anomalous (every org normally has a
// default space), so caching it would strip space-scoped MCP tools org-wide.
// Concurrent turns of one org share a single lookup.
const spaceCache = createCache<string | undefined>({
  name: "chat-default-space",
  ttlMs: SPACE_CACHE_TTL_MS,
});

export function resolveDefaultSpaceId(
  origin: string,
  headers: Record<string, string>,
  orgId: string,
  // Required (no default): callers must pass the platform's in-process dispatch
  // so the default-space lookup rides the loopback-auth seam. A plain
  // `fetch` default would silently bypass it — symmetry with listModels.
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  return spaceCache.get(orgId, () => fetchDefaultSpaceId(origin, headers, orgId, fetchImpl), {
    store: (id) => id !== undefined,
  });
}

async function fetchDefaultSpaceId(
  origin: string,
  headers: Record<string, string>,
  orgId: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${origin}/api/spaces`, { headers });
    if (!res.ok) {
      // A persistent miss silently strips every space-scoped MCP tool for the
      // turn — leave a breadcrumb so it isn't invisible.
      logger.warn("chat: default-space lookup returned non-ok", {
        orgId,
        status: res.status,
      });
      return undefined; // transient — don't cache
    }
    interface Space {
      id: string;
      isDefault?: boolean;
    }
    // `/api/spaces` answers with the same Stripe-canonical list envelope as
    // `/api/models` (`{ object: "list", data, hasMore }` — apps/api
    // `listResponse`, `data` required by the OpenAPI schema): `data` is the
    // only shape. Same reader as `listModels` above, for the same reason.
    const body = (await res.json()) as { data?: Space[] };
    if (!Array.isArray(body.data)) {
      logger.warn("chat: /api/spaces returned an unexpected shape (no data array)", { orgId });
      return undefined; // not the contract — don't cache
    }
    const id = (body.data.find((s) => s.isDefault) ?? body.data[0])?.id;
    if (id) return id;
    return undefined; // empty 200 — anomalous, don't cache
  } catch (err) {
    logger.warn("chat: default-space lookup failed", { orgId, err: String(err) });
    return undefined; // network error — transient, don't cache
  }
}
