// SPDX-License-Identifier: Apache-2.0

/**
 * Model catalog data layer — the non-component half of `model-select.tsx`,
 * split out so the `.tsx` exports only components (Fast Refresh / react-refresh
 * requirement). Holds the wire type + the `/api/models` fetch.
 */

import { CHAT_USABLE_FAMILIES } from "../chat-families.ts";

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
  providerName?: string | null;
  label: string | null;
  /** snake_case to match the `/api/models` wire field (org-models.ts). */
  is_default?: boolean;
  enabled?: boolean;
  /** Model-alias flag — selectable in chat without exposing the backing model. */
  aliased?: boolean;
}

export async function fetchModels(
  getHeaders?: () => Record<string, string>,
): Promise<OrgModelOption[]> {
  try {
    const res = await fetch("/api/models", {
      credentials: "include",
      headers: { ...getHeaders?.() },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: OrgModelOption[]; data?: OrgModelOption[] };
    // Same family gate as the server (pickModel in llm.ts) — shared set so they
    // never drift. claude-code is selectable via its anthropic-messages
    // apiShape; the server routes it to the Claude Agent SDK engine by
    // providerId.
    //
    // Model aliases reach this cookie-authed surface with their backing stripped
    // (`apiShape: null`), so the family gate can't see it — but they're meant to
    // be usable in chat (the user picks the alias; the server resolves the real
    // model). Always include enabled aliases; the loopback `pickModel` does the
    // authoritative family check against the real (unstripped) backing.
    return (body.models ?? body.data ?? []).filter(
      (m) =>
        m.enabled !== false &&
        (m.aliased === true || (!!m.apiShape && CHAT_USABLE_FAMILIES.has(m.apiShape))),
    );
  } catch {
    return [];
  }
}
