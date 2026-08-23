// SPDX-License-Identifier: Apache-2.0

/**
 * Model-alias swap for the in-container sidecar proxy. The policy itself lives
 * in `@appstrate/core/model-swap` (the single source of truth, shared with the
 * platform LLM gateway in `apps/api`). This module re-exports it so the
 * sidecar's local imports and tests keep their stable `./model-swap` path, and
 * owns the one piece that is sidecar-local: parsing the swap descriptor off
 * the process boundary it arrives on (`PI_MODEL_SWAP_JSON`).
 */

import {
  MODEL_API_SHAPES,
  type ModelApiShape,
  type ModelSwap,
} from "@appstrate/core/sidecar-types";
import { isAliasableApiShape } from "@appstrate/core/model-swap";

export {
  swapRequestModel,
  swapResponseModelJson,
  createSseModelSwapStream,
  syntheticAliasErrorBody,
  isAliasableApiShape,
  isAliasInferenceCall,
  LLM_PASSTHROUGH_RESPONSE_HEADERS,
} from "@appstrate/core/model-swap";

/**
 * Parse and validate the model-alias swap descriptor handed to the sidecar as
 * the `PI_MODEL_SWAP_JSON` env var. Same posture as `assertLlmProxyConfig` in
 * `server.ts`, and for a sharper reason: this descriptor is what the `/llm/*`
 * handler consults to decide which single inference call an aliased run may
 * make (`isAliasInferenceCall`). A blind `as ModelSwap` cast lets a platform
 * that predates the `apiShape` field — or any launcher bug that drops it —
 * produce a swap whose shape is `undefined`. The request-time predicate then
 * fails closed, which is the right SECURITY outcome and a terrible diagnostic:
 * the operator gets one 404 per inference attempt, with `apiShape: undefined`
 * buried in a warn log, and nowhere a statement of the cause.
 *
 * THROWS — the sidecar refuses to boot — rather than soft-failing the way
 * `readPositiveIntFromEnv` does a few lines below its call site. That contrast
 * is deliberate, not an inconsistency: a bad `MODEL_CONTEXT_WINDOW` falls back
 * to the legacy run-budget path, and a run on the legacy path is still a run
 * that finishes, so logging and continuing serves the operator. An unusable
 * `modelSwap` has no such fallback. Both alternatives to throwing are worse:
 * dropping the swap would forward the public alias verbatim to the provider
 * (404 upstream on every call, and the descriptor exists precisely so the real
 * id stays out of the container), while booting with the swap kept-but-broken
 * converts one actionable boot error into N mysterious request-time ones. The
 * run can accomplish nothing either way, so fail at boot, once, at the cause —
 * that is the failure a run operator can actually act on.
 *
 * Every message names the offending FIELD and never its value. These logs are
 * operator-visible while the alias's whole contract is that the backing model
 * and provider stay private; `real` names the backing outright and even
 * `apiShape` narrows the candidate vendor set, so neither is echoed.
 *
 * No Zod: the sidecar deliberately carries no validation dependency (see the
 * same note on `assertLlmProxyConfig`), and adding one to the container image
 * for a four-field guard would be disproportionate.
 */
export function parseModelSwapEnv(raw: string): ModelSwap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The raw payload is never echoed — it carries the real backing id.
    throw new Error("PI_MODEL_SWAP_JSON: not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PI_MODEL_SWAP_JSON: expected a JSON object");
  }
  const swap = parsed as Record<string, unknown>;

  for (const field of ["alias", "real"] as const) {
    const value = swap[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`PI_MODEL_SWAP_JSON: missing or blank "${field}"`);
    }
  }

  const apiShape = swap["apiShape"];
  // Widened `includes` so an arbitrary string can be tested against the literal
  // tuple; the narrowing below is sound because of this runtime check.
  if (typeof apiShape !== "string" || !(MODEL_API_SHAPES as readonly string[]).includes(apiShape)) {
    throw new Error('PI_MODEL_SWAP_JSON: missing or unknown "apiShape"');
  }
  if (!isAliasableApiShape(apiShape as ModelApiShape)) {
    // A known protocol, but one whose model id rides in the URL rather than the
    // body — the swap cannot rewrite it, so every call would be refused for a
    // reason no request-time log would ever state.
    throw new Error('PI_MODEL_SWAP_JSON: "apiShape" is not a protocol an alias can be served on');
  }

  return parsed as ModelSwap;
}
