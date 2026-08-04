// SPDX-License-Identifier: Apache-2.0

/**
 * Model resolution — ported from the appstrate-chat satellite (lib/models.ts).
 *
 * The chat owns no LLM key. It lists the org's configured models
 * (`GET /api/models`) and builds an AI SDK model bound to the platform
 * **llm-proxy**, which injects the real provider key server-side and meters
 * the call. The only change from the satellite: instead of an OAuth
 * inference token against a remote instance, we forward the caller's own
 * headers on a loopback request (see self.ts).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { badGateway, invalidRequest } from "@appstrate/core/api-errors";
import { CHAT_USABLE_FAMILIES } from "./chat-families.ts";
import { isModelLive } from "./model-liveness.ts";
import { logger } from "./logger.ts";
import {
  toNativeModelReasoningLevel,
  type ModelGenerationCapabilities,
  type ModelGenerationSettings,
} from "@appstrate/core/model-generation";

const LLM_PROXY_PATH = "/api/llm-proxy";

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
      "Aucun modèle utilisable par le chat n'est configuré. Connectez un modèle par clé API (Anthropic, OpenAI, Mistral) ou un abonnement Claude Code dans Settings → Models.",
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
        "Le modèle sélectionné ne peut plus servir l'inférence : sa connexion doit être rétablie dans Settings → Models.",
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

type ProxyKind = "anthropic" | "openai-compatible";

/** Pure provider-body adapter for chat reasoning controls. */
export function applyGenerationToProxyBody(
  body: BodyInit | null | undefined,
  model: Pick<OrgModel, "apiShape" | "generation">,
  generation: ModelGenerationSettings,
): BodyInit | null | undefined {
  if (generation.reasoningLevel == null || typeof body !== "string") return body;
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const nativeReasoningLevel = toNativeModelReasoningLevel(
      generation.reasoningLevel,
      model.generation,
    );
    if (model.apiShape === "anthropic-messages") {
      const budgets = {
        minimal: 1024,
        low: 2048,
        medium: 4096,
        high: 8192,
        xhigh: 16384,
        max: 32768,
      };
      if (generation.reasoningLevel === "off") {
        delete payload.thinking;
        delete payload.output_config;
      } else if (model.generation?.reasoning.adaptive) {
        payload.thinking = { type: "adaptive" };
        payload.output_config = { effort: nativeReasoningLevel };
      } else {
        payload.thinking = {
          type: "enabled",
          budget_tokens: budgets[generation.reasoningLevel],
        };
      }
    } else {
      payload.reasoning_effort = nativeReasoningLevel;
    }
    return JSON.stringify(payload);
  } catch {
    // Preserve the provider SDK body; it will surface its own parse error.
    return body;
  }
}

/**
 * Map a proxy family to its AI SDK provider kind and the baseURL suffix under
 * `/api/llm-proxy`. Each suffix mirrors the upstream SDK's own path convention
 * so a provider configured here hits the right proxy route:
 *   - Anthropic SDK appends `/v1/messages`         → suffix carries `/v1`.
 *   - OpenAI-compatible appends `/chat/completions` → suffix carries `/v1`.
 * Returns `null` for an unknown family rather than guessing a route.
 *
 * The keys are `platform-routed ∩ AI-SDK-supported`. Two sibling lists are
 * NOT the same policy and must not be merged into this one:
 *   - `apps/api/src/routes/llm-proxy.ts` `routes[]` — the AUTHORITATIVE route
 *     table (deliberately concrete per spec). A family added HERE without a
 *     route THERE 404s; widen the route table first.
 *   - `apps/cli/src/lib/models.ts` `PROXY_SUPPORTED_APIS` —
 *     `platform-routed ∩ pi-ai-supported`. Same three today by coincidence of
 *     SDK support, not by shared definition; the two clients can diverge.
 * {@link CHAT_USABLE_FAMILIES} is a superset on purpose — see below.
 */
function proxyTarget(family: string): { kind: ProxyKind; suffix: string } | null {
  switch (family) {
    case "anthropic-messages":
      return { kind: "anthropic", suffix: "/anthropic-messages/v1" };
    case "openai-completions":
      return { kind: "openai-compatible", suffix: "/openai-completions/v1" };
    case "mistral-conversations":
      return { kind: "openai-compatible", suffix: "/mistral-conversations/v1" };
    // Codex (openai-codex-responses) is intentionally absent: it IS chat-usable
    // now, but as an oauth-subscription it runs on the in-process Pi chat engine
    // (resolved before this point in chat-stream.ts), NOT the llm-proxy — so it
    // must never resolve a proxy target here.
    default:
      return null;
  }
}

/**
 * Build an AI SDK `LanguageModel` for `model`, bound to the llm-proxy.
 * Returns `null` for an unknown family.
 */
export function modelFromFamily(
  model: OrgModel,
  origin: string,
  headers: Record<string, string>,
  mintAuth: () => string,
  platformFetch: typeof fetch,
  generation: ModelGenerationSettings = {},
): LanguageModel | null {
  const target = proxyTarget(model.apiShape);
  if (!target) return null;

  const baseURL = `${origin}${LLM_PROXY_PATH}${target.suffix}`;

  // Re-mint the bearer on every request the SDK makes. The static `headers`
  // bearer expires 60 s after the turn starts; a multi-step turn outlives it,
  // so we overwrite Authorization with a fresh token just before each call.
  const fetchImpl = (async (input, init) => {
    const h = new Headers(init?.headers);
    h.set("authorization", `Bearer ${mintAuth()}`);
    const body = applyGenerationToProxyBody(init?.body, model, generation);
    return platformFetch(input, { ...init, body, headers: h });
  }) as typeof fetch;

  // The proxy resolves `body.model` as the Appstrate **preset id** (the org
  // model row id), then rewrites it to the real upstream model — so we hand
  // the SDK `model.id`, not `model.modelId`.
  // `apiKey` is a placeholder — the real provider key is injected by the
  // proxy. We authenticate with the forwarded caller headers, which override
  // whatever the SDK derives from `apiKey`.
  switch (target.kind) {
    case "anthropic":
      return createAnthropic({ baseURL, apiKey: "proxy", headers, fetch: fetchImpl })(model.id);
    case "openai-compatible":
      return createOpenAICompatible({
        name: "appstrate-llm-proxy",
        baseURL,
        apiKey: "proxy",
        headers,
        fetch: fetchImpl,
        // OpenAI-compatible providers only include token counters in the
        // terminal SSE frame when explicitly requested. Without this flag a
        // successful built-in chat turn can stream normally while the proxy
        // has no usage object to persist or bill.
        includeUsage: true,
      })(model.id);
  }
}

/**
 * App-scoped operations (agents, runs, …) need an application context. A
 * session carries none by default, so resolve the org's default application
 * and forward it as `X-Application-Id` on the MCP request. Cached per org —
 * the default app rarely changes.
 */
// Only RESOLVED ids are cached — never a miss. A miss (transient failure OR an
// empty 200) is left uncached so the next turn retries: an empty
// `/api/applications` is anomalous (every org normally has a default app), so
// caching it would strip app-scoped MCP tools org-wide.
const appCache = new Map<string, string>();

export async function resolveDefaultApplicationId(
  origin: string,
  headers: Record<string, string>,
  orgId: string,
  // Required (no default): callers must pass the platform's in-process dispatch
  // so the default-application lookup rides the loopback-auth seam. A plain
  // `fetch` default would silently bypass it — symmetry with listModels/modelFromFamily.
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const cached = appCache.get(orgId);
  if (cached !== undefined) return cached;
  try {
    const res = await fetchImpl(`${origin}/api/applications`, { headers });
    if (!res.ok) {
      // A persistent miss silently strips every app-scoped MCP tool for the
      // turn — leave a breadcrumb so it isn't invisible.
      logger.warn("chat: default-application lookup returned non-ok", {
        orgId,
        status: res.status,
      });
      return undefined; // transient — don't cache
    }
    interface App {
      id: string;
      isDefault?: boolean;
    }
    const body = (await res.json()) as { data?: App[] } | App[];
    const apps = Array.isArray(body) ? body : (body.data ?? []);
    const id = (apps.find((a) => a.isDefault) ?? apps[0])?.id;
    if (id) {
      appCache.set(orgId, id);
      return id;
    }
    return undefined; // empty 200 — anomalous, don't cache
  } catch (err) {
    logger.warn("chat: default-application lookup failed", { orgId, err: String(err) });
    return undefined; // network error — transient, don't cache
  }
}
