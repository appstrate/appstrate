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
  isDefault?: boolean;
}

interface ResolveArgs {
  origin: string;
  headers: Record<string, string>;
  /** Caller override; otherwise the org default (or first enabled) is used. */
  modelId?: string;
  /**
   * Re-mints the loopback bearer on every proxy call. The `headers` bearer is
   * minted once and expires after 60 s — but a single turn fans out into many
   * inference calls across up to `MAX_STEPS` steps, with `wait_for_run` able to
   * block for minutes in between. Without a fresh mint per call, a long turn
   * hits the proxy with an expired token → 401 Unauthorized mid-stream.
   */
  mintAuth: () => string;
}

export async function listModels(
  origin: string,
  headers: Record<string, string>,
): Promise<OrgModel[]> {
  const res = await fetch(`${origin}/api/models`, { headers });
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
    : (pool.find((m) => m.isDefault) ?? pool[0]);
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
export function proxyTarget(family: string): { kind: ProxyKind; suffix: string } | null {
  switch (family) {
    case "anthropic-messages":
      return { kind: "anthropic", suffix: "/anthropic-messages/v1" };
    case "openai-completions":
      return { kind: "openai-compatible", suffix: "/openai-completions/v1" };
    case "mistral-conversations":
      return { kind: "openai-compatible", suffix: "/mistral-conversations/v1" };
    // Codex (openai-codex-responses) is intentionally absent: it has no
    // llm-proxy route and is refused upstream of here by the codex guard in
    // chat-stream.ts, so it must never resolve to a proxy target.
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
    return fetch(input, { ...init, headers: h });
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
      })(model.id);
  }
}

export async function resolveModel(args: ResolveArgs): Promise<LanguageModel> {
  const models = await listModels(args.origin, args.headers);
  const chosen = pickModel(models, args.modelId);
  const model = modelFromFamily(chosen, args.origin, args.headers, args.mintAuth);
  if (!model) {
    throw invalidRequest(
      `Model family "${chosen.apiShape}" is not supported by the chat (use openai-completions, anthropic-messages or mistral-conversations).`,
    );
  }
  logger.info("model resolved", {
    model: chosen.id,
    modelId: chosen.modelId,
    family: chosen.apiShape,
  });
  return model;
}

/**
 * App-scoped operations (agents, runs, …) need an application context. A
 * session carries none by default, so resolve the org's default application
 * and forward it as `X-Application-Id` on the MCP request. Cached per org —
 * the default app rarely changes.
 */
const appCache = new Map<string, string | null>();
const APP_CACHE_MAX = 500;

/** Bounded insert: evict the oldest entry once the per-org cache is full. */
function cacheApp(orgId: string, id: string | null): void {
  if (appCache.size >= APP_CACHE_MAX && !appCache.has(orgId)) {
    const oldest = appCache.keys().next().value;
    if (oldest !== undefined) appCache.delete(oldest);
  }
  appCache.set(orgId, id);
}

export async function resolveDefaultApplicationId(
  origin: string,
  headers: Record<string, string>,
  orgId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const cached = appCache.get(orgId);
  if (cached !== undefined) return cached ?? undefined;
  try {
    const res = await fetchImpl(`${origin}/api/applications`, { headers });
    if (!res.ok) {
      // Transient upstream failure — do NOT cache, or a single blip would
      // poison the cache and strip app-scoped MCP tools for this org until
      // eviction. Return undefined and let the next call retry.
      return undefined;
    }
    interface App {
      id: string;
      isDefault?: boolean;
    }
    const body = (await res.json()) as { data?: App[] } | App[];
    const apps = Array.isArray(body) ? body : (body.data ?? []);
    const id = (apps.find((a) => a.isDefault) ?? apps[0])?.id ?? null;
    // Only resolved state is cached: a real id, or null for "org genuinely has
    // no application" — never a transient fetch failure.
    cacheApp(orgId, id);
    return id ?? undefined;
  } catch {
    // Network error — transient, don't poison the cache.
    return undefined;
  }
}
