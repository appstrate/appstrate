// SPDX-License-Identifier: Apache-2.0

/**
 * Live model search, served for OpenRouter only. That provider serves more
 * models than Pi's registry records, so a model bound to it may be any id it
 * serves, not only its offer.
 */

import type { ModelCost, ModelInputModality } from "@appstrate/core/module";
import { getErrorMessage } from "@appstrate/core/errors";
import { ApiError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";

export interface SearchedModel {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  input: ModelInputModality[];
  reasoning: boolean;
  cost: ModelCost | null;
}

const LIVE_SEARCH_PROVIDER_ID = "openrouter";

export function hasLiveModelSearch(providerId: string): boolean {
  return providerId === LIVE_SEARCH_PROVIDER_ID;
}

/** OpenRouter's models matching `query` (id or name), at most 50. */
export async function searchOpenRouterModels(query: string): Promise<SearchedModel[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new ApiError({
        status: 502,
        code: "provider_error",
        title: "Provider Error",
        detail: `OpenRouter returned ${res.status}`,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const rawModels = json?.data;
    if (!Array.isArray(rawModels)) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let models = rawModels.map((m: any): SearchedModel => {
      // OpenRouter pricing is per-token; convert to $/M tokens for ModelCost
      const pricing = m.pricing;
      const promptPerToken = parseFloat(pricing?.prompt);
      const completionPerToken = parseFloat(pricing?.completion);
      const cacheReadPerToken = parseFloat(pricing?.input_cache_read);
      // A missing (NaN) or negative rate is unpublished: OpenRouter's `-1` marks
      // a variable price (`openrouter/auto`), the Pi catalog's rule too.
      const published = (rate: number): boolean => rate >= 0;
      const hasValidPricing = published(promptPerToken) && published(completionPerToken);

      return {
        id: String(m.id ?? ""),
        name: String(m.name || m.id || ""),
        contextWindow: typeof m.context_length === "number" ? m.context_length : null,
        maxTokens:
          typeof m.top_provider?.max_completion_tokens === "number"
            ? m.top_provider.max_completion_tokens
            : null,
        input: m.architecture?.input_modalities?.includes?.("image") ? ["text", "image"] : ["text"],
        reasoning: false,
        // An unreported rate stays ABSENT, never `0`: `classifyTokenPricing`
        // reads a stored `0` as a real (free) price.
        cost: hasValidPricing
          ? {
              input: promptPerToken * 1_000_000,
              output: completionPerToken * 1_000_000,
              ...(published(cacheReadPerToken) ? { cacheRead: cacheReadPerToken * 1_000_000 } : {}),
            }
          : null,
      };
    });

    if (query.trim()) {
      const lower = query.toLowerCase();
      models = models.filter(
        (m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower),
      );
    }
    return models.slice(0, 50);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError({
        status: 504,
        code: "timeout",
        title: "Gateway Timeout",
        detail: "OpenRouter request timed out",
      });
    }
    logger.error("OpenRouter model search failed", {
      error: getErrorMessage(err),
    });
    throw new ApiError({
      status: 502,
      code: "network_error",
      title: "Bad Gateway",
      detail: "Failed to fetch OpenRouter models",
    });
  }
}
