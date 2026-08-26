// SPDX-License-Identifier: Apache-2.0

/**
 * Model-alias swap for the sidecar's `/llm/*` boundary. The policy itself lives
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
import {
  type AliasBackingApiShape,
  isAliasBackingShape,
  isAliasClientShape,
} from "@appstrate/core/model-swap";

export {
  syntheticAliasErrorBody,
  syntheticAliasClassifierMessage,
  isAliasInferenceCall,
  projectAliasUpstreamStatus,
  ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS,
  LLM_PASSTHROUGH_RESPONSE_HEADERS,
} from "@appstrate/core/model-swap";

/**
 * Parse the swap descriptor off `PI_MODEL_SWAP_JSON`.
 *
 * THROWS — the sidecar refuses to boot. An unusable descriptor has no fallback:
 * keeping it broken turns one actionable boot error into a 404 per inference
 * attempt, with nothing stating the cause.
 *
 * Messages name the offending FIELD, never its value. These logs are
 * operator-visible and `real` names the backing outright, while even a protocol
 * family narrows the candidate vendor set.
 *
 * No Zod: the sidecar image carries no validation dependency.
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

  // Two protocols, two different rules: what the container speaks to `/llm/*`
  // and what the backing speaks upstream. Neither is inferred from the other.
  requireClientShape(swap);
  requireBackingShape(swap);

  // The sidecar always terminates the client protocol and RE-ORIGINATES against
  // the backing, so the catalog to rebuild its pi-ai `Model` from is mandatory.
  // Missing it, every request would throw deep inside the stream instead.
  const backing = swap["backing"];
  if (!backing || typeof backing !== "object" || Array.isArray(backing)) {
    throw new Error('PI_MODEL_SWAP_JSON: missing "backing"');
  }
  const b = backing as Record<string, unknown>;
  if (typeof b["providerId"] !== "string" || b["providerId"].trim().length === 0) {
    throw new Error('PI_MODEL_SWAP_JSON: missing or blank "backing.providerId"');
  }
  if (typeof b["reasoning"] !== "boolean") {
    throw new Error('PI_MODEL_SWAP_JSON: missing or non-boolean "backing.reasoning"');
  }
  if (!Array.isArray(b["input"]) || b["input"].length === 0) {
    throw new Error('PI_MODEL_SWAP_JSON: missing or empty "backing.input"');
  }

  return parsed as ModelSwap;
}

/**
 * Read one protocol field off the raw descriptor, or throw naming the FIELD.
 *
 * Never the value: these logs are operator-visible while the alias's whole
 * contract is that the backing stays private, and a protocol family narrows
 * the candidate vendor set on its own.
 */
function readApiShape(
  swap: Record<string, unknown>,
  field: "clientApiShape" | "backingApiShape",
): ModelApiShape {
  const value = swap[field];
  // Widened `includes` so an arbitrary string can be tested against the literal
  // tuple; the narrowing below is sound because of this runtime check.
  if (typeof value !== "string" || !(MODEL_API_SHAPES as readonly string[]).includes(value)) {
    throw new Error(`PI_MODEL_SWAP_JSON: missing or unknown "${field}"`);
  }
  return value as ModelApiShape;
}

/** The dialect an aliased container speaks; the sidecar terminates it here. */
function requireClientShape(swap: Record<string, unknown>): ModelApiShape {
  const shape = readApiShape(swap, "clientApiShape");
  if (!isAliasClientShape(shape)) {
    throw new Error(
      'PI_MODEL_SWAP_JSON: "clientApiShape" is not the protocol an aliased container speaks',
    );
  }
  return shape;
}

/**
 * The backing's own protocol. Anything outside the backing set would be
 * refused per-request deep inside the stream instead — say it at boot.
 */
function requireBackingShape(swap: Record<string, unknown>): AliasBackingApiShape {
  const shape = readApiShape(swap, "backingApiShape");
  if (!isAliasBackingShape(shape)) {
    throw new Error(
      'PI_MODEL_SWAP_JSON: "backingApiShape" is not a protocol an alias can be backed by',
    );
  }
  return shape;
}
