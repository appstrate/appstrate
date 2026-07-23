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
import { logger } from "./logger.ts";

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
}

export async function listModels(
  origin: string,
  headers: Record<string, string>,
  platformFetch: typeof fetch,
  opts?: { metadataOnly?: boolean },
): Promise<OrgModel[]> {
  // `metadata_only` skips the per-model credential decrypt + reachability filter
  // — faster, but it also stops dropping models whose credential is dead
  // (needs-reconnection). Safe ONLY when the caller will match an explicit,
  // user-picked id (that id came from the browser's filtered picker, so it is
  // already reachable). For DEFAULT resolution (no explicit id) we must use the
  // full filtered list, or a dead org-default would be picked and fail at
  // inference. The caller passes `metadataOnly` accordingly.
  const url = opts?.metadataOnly
    ? `${origin}/api/models?metadata_only=true`
    : `${origin}/api/models`;
  const res = await platformFetch(url, { headers });
  if (!res.ok) throw badGateway(`/api/models returned ${res.status}`);
  const body = (await res.json()) as { models?: OrgModel[]; data?: OrgModel[] };
  const models = body.models ?? body.data;
  if (!models) {
    logger.warn("/api/models returned an unexpected shape (no models/data)");
    return [];
  }
  return models;
}

export function pickModel(models: OrgModel[], modelId?: string): OrgModel {
  // `enabled` is opt-out: a missing flag counts as enabled.
  const pool = models.filter((m) => m.enabled !== false && CHAT_USABLE_FAMILIES.has(m.apiShape));
  if (pool.length === 0 && models.some((m) => m.enabled !== false)) {
    throw invalidRequest(
      "Aucun modèle utilisable par le chat n'est configuré. Connectez un modèle par clé API (Anthropic, OpenAI, Mistral) ou un abonnement Claude Code dans Settings → Models.",
    );
  }
  const chosen = modelId
    ? pool.find((m) => m.id === modelId || m.modelId === modelId)
    : (pool.find((m) => m.is_default) ?? pool[0]);
  if (!chosen) {
    throw invalidRequest(
      modelId
        ? `Model "${modelId}" is not an enabled model on this instance.`
        : "No enabled model is configured (Settings → Models).",
    );
  }
  return chosen;
}

type ProxyKind = "anthropic" | "openai-compatible";

/**
 * Map a proxy family to its AI SDK provider kind and the baseURL suffix under
 * `/api/llm-proxy`. Each suffix mirrors the upstream SDK's own path convention
 * so a provider configured here hits the right proxy route:
 *   - Anthropic SDK appends `/v1/messages`         → suffix carries `/v1`.
 *   - OpenAI-compatible appends `/chat/completions` → suffix carries `/v1`.
 * Returns `null` for an unknown family rather than guessing a route.
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
    return platformFetch(input, { ...init, headers: h });
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
