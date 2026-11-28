// SPDX-License-Identifier: Apache-2.0

/**
 * Model catalog data layer — the non-component half of `model-select.tsx`,
 * split out so the `.tsx` exports only components (Fast Refresh / react-refresh
 * requirement). Holds the wire type + the `/api/models` fetch.
 */

import { z } from "zod";
import type { ChatRequest } from "./runtime-context.ts";
import { CHAT_USABLE_FAMILIES } from "../chat-families.ts";
import {
  modelGenerationCapabilitiesSchema,
  type ModelGenerationCapabilities,
} from "@appstrate/core/model-generation";
import { MODEL_PAYERS, type ModelPayer } from "@appstrate/core/model-payer";

/**
 * Runtime shape of a single `/api/models` row we depend on. The endpoint
 * returns a richer object (OrgModelInfo) — Zod strips the extra keys. Parsing
 * per-entry with `safeParse` (rather than an `as`-cast) means a malformed row
 * is dropped instead of flowing into the family gate as `undefined` field
 * accesses on a non-object.
 */
const orgModelOptionSchema = z.object({
  id: z.string(),
  modelId: z.string().nullable(),
  apiShape: z.string().nullable(),
  providerId: z.string().nullable().optional(),
  provider_name: z.string().nullable().optional(),
  label: z.string().nullable(),
  is_default: z.boolean().optional(),
  needs_reconnection: z.boolean().optional(),
  enabled: z.boolean().optional(),
  aliased: z.boolean().optional(),
  generation: modelGenerationCapabilitiesSchema.nullable().optional(),
  input: z.array(z.string()).nullable().optional(),
  contextWindow: z.number().nullable().optional(),
  maxTokens: z.number().nullable().optional(),
  billed_to: z.enum(MODEL_PAYERS).nullable().optional(),
  config_id: z.string().nullable().optional(),
});

export interface OrgModelOption {
  id: string;
  /** `null` for model aliases — the real binding is hidden from the browser. */
  modelId: string | null;
  /** `null` for model aliases — the backing protocol is hidden from the browser. */
  apiShape: string | null;
  providerId?: string | null;
  /**
   * Provider display name, resolved server-side from the model-provider registry
   * by `providerId` (e.g. "OpenCode Go"). The picker groups/labels by this —
   * `apiShape` alone is ambiguous (OpenCode Go shares `openai-completions` with
   * OpenAI). `null` for aliases (binding hidden) or rows with no registry entry.
   */
  provider_name?: string | null;
  /** Who pays for the caller: their own connection, the org's, or `null` (none serves it). */
  billed_to?: ModelPayer | null;
  /** The model configuration whose connections serve it; `null` for a built-in model or an alias. */
  config_id?: string | null;
  label: string | null;
  /** snake_case to match the `/api/models` wire field (org-models.ts). */
  is_default?: boolean;
  /**
   * The model's credential can no longer serve inference (revoked OAuth, or a
   * stored blob that no longer decrypts). Listed but not selectable — the
   * picker shows it marked so the user can see WHY it disappeared from use.
   */
  needs_reconnection?: boolean;
  enabled?: boolean;
  /** Model-alias flag — selectable in chat without exposing the backing model. */
  aliased?: boolean;
  generation?: ModelGenerationCapabilities | null;
  /** Input modalities the model declares (`["text", "image"]`); `null`/absent = not known (aliases hide it). */
  input?: string[] | null;
  /** The catalog's limits, cascade applied; `null` when it has none (and always for an alias). */
  contextWindow?: number | null;
  maxTokens?: number | null;
}

/** `GET /api/models`, whole: the cache entry the shell's `$api` models queries share. */
export async function fetchModelsEnvelope(request: ChatRequest): Promise<unknown> {
  return (await request("/api/models")).json();
}

/** The catalog rows the chat can offer, from the `/api/models` envelope. */
export function selectChatModels(envelope: unknown): OrgModelOption[] {
  try {
    // Stripe-canonical list envelope `{ object: "list", data, hasMore }` — the
    // single shape `/api/models` returns (apps/api `listResponse`; `data` is
    // required by the OpenAPI schema). Same read as the server-side
    // `listModels` in `../llm.ts`.
    const body = envelope as { data?: unknown };
    const rawList = Array.isArray(body.data) ? body.data : [];
    // Narrow each row through Zod, dropping any that don't match — never trust
    // the wire shape with a blind cast.
    const models: OrgModelOption[] = rawList.flatMap((row) => {
      const parsed = orgModelOptionSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    // Same family gate as the server (pickModel in llm.ts) — shared set so they
    // never drift. Subscription models (claude-code via anthropic-messages,
    // codex via openai-codex-responses) pass the gate too; every model runs on
    // the same engine, and the model row's provider only decides which
    // credential the turn spends.
    //
    // Model aliases reach this cookie-authed surface with their backing stripped
    // (`apiShape: null`), so the family gate can't see it — but they're meant to
    // be usable in chat (the user picks the alias; the server resolves the real
    // model). Always include enabled aliases; the loopback `pickModel` does the
    // authoritative family check against the real (unstripped) backing.
    return models.filter(
      (m) =>
        m.enabled !== false &&
        (m.aliased === true || (!!m.apiShape && CHAT_USABLE_FAMILIES.has(m.apiShape))),
    );
  } catch {
    return [];
  }
}
