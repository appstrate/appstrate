// SPDX-License-Identifier: Apache-2.0

/**
 * Model listing — read the ids a credential's provider actually serves.
 *
 * One guarded `GET <baseUrl>/models` request (built and sent by
 * `fetchModelListing`, the same transport the credential test uses), with its
 * body parsed according to the provider's `apiShape`. Callers decide what to
 * do with the ids: `model-discovery.ts` intersects them with the provider's
 * discovery candidates.
 */

import { fetchModelListing } from "../org-models.ts";

/** Upper bound on ids taken from one listing response. */
const MAX_SERVED_MODEL_IDS = 1000;

type ListServedModelsError =
  "AUTH_FAILED" | "RATE_LIMITED" | "UNREACHABLE" | "BLOCKED_URL" | "BAD_RESPONSE" | "HTTP_ERROR";

export type ListServedModelsResult =
  | { ok: true; modelIds: string[]; latency: number }
  | { ok: false; error: ListServedModelsError; status?: number; message: string };

/** Where the ids sit in a `/models` response body, per `apiShape`. */
function listingShape(apiShape: string): {
  key: "data" | "models";
  field: "id" | "name";
  prefix: string;
} {
  // Google enumerates `{ models: [{ name: "models/<id>" }] }`; every other
  // shape answers `{ data: [{ id: "<id>" }] }`.
  return apiShape === "google-generative-ai" || apiShape === "google-vertex"
    ? { key: "models", field: "name", prefix: "models/" }
    : { key: "data", field: "id", prefix: "" };
}

function readString(entry: unknown, field: string): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/**
 * Extract the served model ids from a `/models` response body. `null` means
 * the body carries no listing at all — a response nobody can read must not be
 * mistaken for a provider that serves nothing. Strict on the container, lenient
 * inside it: an entry with no usable id is skipped, because one odd row must
 * not discard a listing whose other rows are perfectly readable. Ids keep
 * response order, deduped, capped at {@link MAX_SERVED_MODEL_IDS}.
 */
export function parseServedModelIds(apiShape: string, body: unknown): string[] | null {
  const { key, field, prefix } = listingShape(apiShape);
  if (typeof body !== "object" || body === null) return null;
  const entries = (body as Record<string, unknown>)[key];
  if (!Array.isArray(entries)) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = readString(entry, field);
    if (raw === null) continue;
    const id = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === MAX_SERVED_MODEL_IDS) break;
  }
  return ids;
}

/** List the model ids a credential's provider serves. */
export async function listServedModelIds(config: {
  apiShape: string;
  baseUrl: string;
  apiKey: string;
  providerId?: string;
}): Promise<ListServedModelsResult> {
  const listing = await fetchModelListing(config);
  if (!listing.ok) {
    // No response reached us at all. A refused URL keeps its own verdict — the
    // operator fixes it with `EGRESS_ALLOW_INTERNAL_HOSTS`, not by retrying —
    // while timeouts, DNS/TCP/TLS failures and refused redirects are all
    // "the provider did not answer".
    return {
      ok: false,
      error: listing.failure.error === "BLOCKED_URL" ? "BLOCKED_URL" : "UNREACHABLE",
      message: listing.failure.message ?? "Model listing request failed",
    };
  }

  const { res, latency } = listing;
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: "AUTH_FAILED",
        status: res.status,
        message: "Authentication failed",
      };
    }
    if (res.status === 429) {
      return { ok: false, error: "RATE_LIMITED", status: res.status, message: "Rate limited" };
    }
    return {
      ok: false,
      error: "HTTP_ERROR",
      status: res.status,
      message: `Provider returned ${res.status}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      error: "BAD_RESPONSE",
      status: res.status,
      message: "Model listing is not JSON",
    };
  }

  const modelIds = parseServedModelIds(config.apiShape, body);
  if (!modelIds) {
    return {
      ok: false,
      error: "BAD_RESPONSE",
      status: res.status,
      message: `Unrecognised model listing shape for ${config.apiShape}`,
    };
  }
  return { ok: true, modelIds, latency };
}
