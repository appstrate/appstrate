// SPDX-License-Identifier: Apache-2.0

/**
 * What a credential's provider serves: guarded `GET <baseUrl>/models` requests
 * (`fetchModelListing`, the credential test's transport), parsed per
 * `apiShape`. Per-entry capability fields some servers publish (vLLM
 * `max_model_len`, Mistral `capabilities`, OpenRouter `context_length` /
 * `architecture` / `supported_parameters`, LM Studio `max_context_length`)
 * are read from the entry in hand as hints.
 *
 * A listing that declares a next page is followed to its end: Anthropic's
 * `/v1/models` answers 20 entries with `has_more` / `last_id`, so reading one
 * page would hand the operator a silently short list. Following stops at
 * {@link MAX_LISTING_PAGES} pages or {@link MAX_SERVED_MODELS} models, and a
 * result cut by either cap says so (`truncated`) instead of passing for a
 * complete listing. Each page's body is read under a byte budget
 * ({@link MAX_LISTING_BODY_BYTES}) — the endpoint is operator-supplied, so a
 * body that streams past it is refused rather than buffered.
 */

import { fetchModelListing } from "../org-models.ts";
import { logger } from "../../lib/logger.ts";

/** Upper bound on models taken from a listing, across all of its pages. */
const MAX_SERVED_MODELS = 1000;

/** Upper bound on listing requests per call — a cursor that never ends must stop. */
const MAX_LISTING_PAGES = 10;

/**
 * Upper bound on one page's response body. The endpoint is operator-supplied
 * (`POST /discover` takes an arbitrary `base_url_override`), so it is
 * untrusted: `res.json()` buffers whatever it streams, and the request timeout
 * alone bounds the duration, not the bytes. A page carrying
 * {@link MAX_SERVED_MODELS} entries with full metadata sits an order of
 * magnitude under this.
 */
const MAX_LISTING_BODY_BYTES = 4 * 1024 * 1024;

/** Input modalities a listing entry or a catalog entry can advertise, in canonical order. */
export const INPUT_MODALITIES = ["text", "image"] as const;

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
  | {
      ok: true;
      models: ServedModel[];
      /** The endpoint had more to say and a cap stopped the read — `models` is short. */
      truncated: boolean;
    }
  | { ok: false; error: ListServedModelsError; status?: number; message: string };

/** The query that asks a listing for the page after the one in hand. */
interface PageQuery {
  name: string;
  value: string;
}

/**
 * How a `/models` response body is laid out, per `apiShape`: where the ids sit,
 * and how it points at its next page.
 */
function listingShape(apiShape: string): {
  key: "data" | "models";
  field: "id" | "name";
  prefix: string;
  /** Field whose `true` declares a next page; `null` when the cursor's presence is the signal. */
  moreFlag: string | null;
  /** Field carrying the cursor, and the query parameter that spends it. */
  cursorField: string;
  cursorParam: string;
} {
  // Google enumerates `{ models: [{ name: "models/<id>" }] }` and pages with
  // `nextPageToken` / `?pageToken=`; every other shape answers
  // `{ data: [{ id: "<id>" }] }` and pages on the OpenAI/Anthropic cursor
  // (`has_more` + `last_id`, spent as `?after_id=`).
  return apiShape === "google-generative-ai" || apiShape === "google-vertex"
    ? {
        key: "models",
        field: "name",
        prefix: "models/",
        moreFlag: null,
        cursorField: "nextPageToken",
        cursorParam: "pageToken",
      }
    : {
        key: "data",
        field: "id",
        prefix: "",
        moreFlag: "has_more",
        cursorField: "last_id",
        cursorParam: "after_id",
      };
}

/**
 * What a listing body says about a next page. `more` without a `query` is an
 * endpoint that declares more and gives nothing to ask with: unfollowable, and
 * therefore truncated rather than complete.
 */
function nextPage(apiShape: string, body: unknown): { more: boolean; query: PageQuery | null } {
  const { moreFlag, cursorField, cursorParam } = listingShape(apiShape);
  const container = readRecord(body);
  if (container === null) return { more: false, query: null };
  const cursor = container[cursorField];
  const usable = typeof cursor === "string" && cursor.length > 0;
  if (moreFlag === null) {
    return usable
      ? { more: true, query: { name: cursorParam, value: cursor } }
      : { more: false, query: null };
  }
  if (container[moreFlag] !== true) return { more: false, query: null };
  return { more: true, query: usable ? { name: cursorParam, value: cursor } : null };
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

/** Per entry, whatever the container shape. A wrong-typed value leaves its key absent. */
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

/** One page of a listing, and whether {@link MAX_SERVED_MODELS} cut it short. */
export interface ParsedServedModels {
  models: ServedModel[];
  capped: boolean;
}

/**
 * `null` = no listing at all (not "serves nothing"). Strict on the container,
 * lenient inside: an entry with no usable id is skipped. Response order,
 * deduped on id (first wins), capped at {@link MAX_SERVED_MODELS} — one page's
 * worth; `listServedModels` holds the same cap across a paginated listing and
 * carries `capped` into its own `truncated` verdict.
 */
export function parseServedModels(apiShape: string, body: unknown): ParsedServedModels | null {
  const { key, field, prefix } = listingShape(apiShape);
  const container = readRecord(body);
  if (container === null) return null;
  const entries = container[key];
  if (!Array.isArray(entries)) return null;

  const models: ServedModel[] = [];
  const seen = new Set<string>();
  let capped = false;
  for (const entry of entries) {
    const record = readRecord(entry);
    if (record === null) continue;
    const raw = record[field];
    if (typeof raw !== "string") continue;
    const id = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (id.length === 0 || seen.has(id)) continue;
    if (models.length === MAX_SERVED_MODELS) {
      capped = true;
      break;
    }
    seen.add(id);
    models.push({ id, hints: sniffHints(record) });
  }
  return { models, capped };
}

interface ListingConfig {
  apiShape: string;
  baseUrl: string;
  apiKey: string;
  providerId?: string;
}

/** One page of a listing: its parsed body, or the verdict that stopped it. */
type ListingPageResult =
  | { ok: true; body: unknown; status: number }
  | { ok: false; error: ListServedModelsError; status?: number; message: string };

/** One guarded `GET <baseUrl>/models`, mapped from transport/HTTP failure to verdict. */
async function fetchListingPage(
  config: ListingConfig,
  pageQuery?: PageQuery,
): Promise<ListingPageResult> {
  const listing = await fetchModelListing(config, pageQuery);
  if (!listing.ok) {
    // A refused URL keeps its verdict (fixed by `EGRESS_ALLOW_INTERNAL_HOSTS`,
    // not by retrying); anything else is "the provider did not answer".
    return {
      ok: false,
      error: listing.error === "BLOCKED_URL" ? "BLOCKED_URL" : "UNREACHABLE",
      message: listing.message ?? "Model listing request failed",
    };
  }

  const { res } = listing;
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

  const parsed = await readBoundedJson(res);
  if (!parsed.ok) {
    return { ok: false, error: "BAD_RESPONSE", status: res.status, message: parsed.message };
  }
  return { ok: true, body: parsed.body, status: res.status };
}

/**
 * Read a response body as JSON under {@link MAX_LISTING_BODY_BYTES}, cancelling
 * the stream the moment it crosses. Refuses rather than truncates: half a JSON
 * document parses to nothing, and a listing that large is not one the platform
 * would serve anyway. The budget is spent on the stream, not on a declared
 * `content-length` — an untrusted endpoint's header is not a bound.
 */
async function readBoundedJson(
  res: Response,
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  if (res.body === null) return { ok: false, message: "Model listing is not JSON" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LISTING_BODY_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          message: `Model listing exceeds ${MAX_LISTING_BODY_BYTES} bytes`,
        };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, message: "Model listing request failed" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, message: "Model listing is not JSON" };
  }
}

/**
 * List the models a credential's provider serves, following the listing's own
 * cursor across pages. Response order, deduped on id across pages (first wins).
 */
export async function listServedModels(config: ListingConfig): Promise<ListServedModelsResult> {
  const models: ServedModel[] = [];
  const seen = new Set<string>();
  let pageQuery: PageQuery | undefined;

  for (let page = 1; ; page++) {
    const fetched = await fetchListingPage(config, pageQuery);
    if (!fetched.ok) return fetched;

    const parsed = parseServedModels(config.apiShape, fetched.body);
    if (!parsed) {
      return {
        ok: false,
        error: "BAD_RESPONSE",
        status: fetched.status,
        message: `Unrecognised model listing shape for ${config.apiShape}`,
      };
    }

    for (const model of parsed.models) {
      if (seen.has(model.id)) continue;
      if (models.length === MAX_SERVED_MODELS) {
        return truncatedListing(config, models, "model cap reached");
      }
      seen.add(model.id);
      models.push(model);
    }
    if (parsed.capped) return truncatedListing(config, models, "model cap reached");

    const next = nextPage(config.apiShape, fetched.body);
    if (!next.more) return { ok: true, models, truncated: false };
    if (next.query === null) {
      return truncatedListing(
        config,
        models,
        "listing declares more pages but publishes no cursor",
      );
    }
    if (page === MAX_LISTING_PAGES) {
      return truncatedListing(config, models, "page cap reached");
    }
    pageQuery = next.query;
  }
}

/** A short listing is a success the caller must be able to see through. */
function truncatedListing(
  config: ListingConfig,
  models: ServedModel[],
  reason: string,
): ListServedModelsResult {
  logger.warn("model listing truncated — the endpoint serves more than was read", {
    providerId: config.providerId,
    apiShape: config.apiShape,
    modelCount: models.length,
    reason,
  });
  return { ok: true, models, truncated: true };
}
