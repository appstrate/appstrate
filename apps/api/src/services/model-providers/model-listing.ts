// SPDX-License-Identifier: Apache-2.0

/**
 * Model listing — read what a credential's provider actually serves.
 *
 * One guarded `GET <baseUrl>/models` request (built and sent by
 * `fetchModelListing`, the same transport the credential test uses), with its
 * body parsed according to the provider's `apiShape`. Callers decide what to
 * do with the result: `model-discovery.ts` intersects the ids with the
 * provider's discovery candidates, `routes/model-provider-credentials.ts`
 * merges the hints into the catalog description.
 *
 * The `/models` protocol carries no capability contract, but several servers
 * publish extra fields per entry (vLLM `max_model_len`, Mistral
 * `capabilities`, OpenRouter `context_length` / `architecture` /
 * `supported_parameters`, LM Studio `max_context_length`). Those are read
 * from the entry already in hand — nothing more is requested — and an entry
 * that publishes none simply carries no hint.
 */

import { fetchModelListing } from "../org-models.ts";

/** Upper bound on models taken from one listing response. */
const MAX_SERVED_MODELS = 1000;

/** Input modalities a listing entry can advertise, in canonical order. */
const INPUT_MODALITIES = ["text", "image"] as const;

/** Context-window fields, in the order the first positive integer wins. */
const CONTEXT_WINDOW_FIELDS = ["max_model_len", "context_length", "max_context_length"] as const;

/** What a listing entry says about the model, beyond its id. Only the keys it published. */
export interface ServedModelHints {
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
}

/** One model an endpoint serves. */
export interface ServedModel {
  id: string;
  hints: ServedModelHints;
}

type ListServedModelsError =
  "AUTH_FAILED" | "RATE_LIMITED" | "UNREACHABLE" | "BLOCKED_URL" | "BAD_RESPONSE" | "HTTP_ERROR";

export type ListServedModelsResult =
  | { ok: true; models: ServedModel[]; latency: number }
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

/**
 * Read the capability fields an entry publishes. Sniffing is per entry and
 * independent of the container shape — the same fields are looked for
 * whatever `apiShape` the response came in. A value of the wrong type leaves
 * its key absent rather than throwing: one odd field must not cost the rest of
 * the entry.
 */
function sniffHints(entry: Record<string, unknown>): ServedModelHints {
  const hints: ServedModelHints = {};

  for (const field of CONTEXT_WINDOW_FIELDS) {
    const contextWindow = readPositiveInt(entry[field]);
    if (contextWindow !== null) {
      hints.contextWindow = contextWindow;
      break;
    }
  }

  const maxTokens =
    readPositiveInt(readRecord(entry.top_provider)?.max_completion_tokens) ??
    readPositiveInt(entry.max_output_tokens);
  if (maxTokens !== null) hints.maxTokens = maxTokens;

  const capabilities = readRecord(entry.capabilities);
  const modalities = readStringArray(readRecord(entry.architecture)?.input_modalities);
  if (modalities !== null) {
    const input = INPUT_MODALITIES.filter((m) => modalities.includes(m));
    if (input.length > 0) hints.input = input;
  } else {
    const vision = readBoolean(capabilities?.vision);
    if (vision !== null) hints.input = vision ? ["text", "image"] : ["text"];
  }

  if (readStringArray(entry.supported_parameters)?.includes("reasoning")) {
    hints.reasoning = true;
  } else {
    const reasoning = readBoolean(capabilities?.reasoning);
    if (reasoning !== null) hints.reasoning = reasoning;
  }

  return hints;
}

/**
 * Extract the served models from a `/models` response body. `null` means the
 * body carries no listing at all — a response nobody can read must not be
 * mistaken for a provider that serves nothing. Strict on the container, lenient
 * inside it: an entry with no usable id is skipped, because one odd row must
 * not discard a listing whose other rows are perfectly readable. Models keep
 * response order, deduped on id (first occurrence wins, hints included),
 * capped at {@link MAX_SERVED_MODELS}.
 */
export function parseServedModels(apiShape: string, body: unknown): ServedModel[] | null {
  const { key, field, prefix } = listingShape(apiShape);
  const container = readRecord(body);
  if (container === null) return null;
  const entries = container[key];
  if (!Array.isArray(entries)) return null;

  const models: ServedModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = readRecord(entry);
    if (record === null) continue;
    const raw = record[field];
    if (typeof raw !== "string") continue;
    const id = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, hints: sniffHints(record) });
    if (models.length === MAX_SERVED_MODELS) break;
  }
  return models;
}

/** List the models a credential's provider serves. */
export async function listServedModels(config: {
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

  const models = parseServedModels(config.apiShape, body);
  if (!models) {
    return {
      ok: false,
      error: "BAD_RESPONSE",
      status: res.status,
      message: `Unrecognised model listing shape for ${config.apiShape}`,
    };
  }
  return { ok: true, models, latency };
}
