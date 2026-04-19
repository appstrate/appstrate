// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared Ajv2020 + ajv-formats factory.
 *
 * Both the backend (apps/api validation) and the frontend (RJSF validator)
 * need an Ajv instance configured identically so client- and server-side
 * validation agree on the same JSON Schema 2020-12 dialect. The awkward
 * `unknown` casts required at the ajv-formats + ajv/dist/2020 boundary live
 * here once, instead of being duplicated at every call site.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

// ajv-formats ships a CJS default-export under an ESM wrapper; the named type
// exposed by @types/ajv-formats expects AJV's Ajv (draft-07) class. The 2020-12
// class is runtime-compatible. Cast through `unknown` once and forget.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

/** Options passed through to Ajv2020 on construction. */
export interface CreateAjvOptions {
  /** Coerce string → number/boolean on input. Default: false. */
  coerceTypes?: boolean;
  /** Report all errors instead of stopping at the first. Default: true. */
  allErrors?: boolean;
  /** `strict: false` is the Appstrate-wide default — manifests carry UI hints
   *  that AJV would otherwise reject. */
  strict?: boolean;
}

/** Build an Ajv2020 instance with ajv-formats registered. */
export function createAjv(opts: CreateAjvOptions = {}): Ajv2020 {
  const ajv = new Ajv2020({
    coerceTypes: opts.coerceTypes ?? false,
    allErrors: opts.allErrors ?? true,
    strict: opts.strict ?? false,
  });
  addFormats(ajv);
  return ajv;
}

/** Exposed for callers that need the concrete class (e.g. RJSF's
 *  `customizeValidator({ AjvClass })`). Cast-site is encapsulated here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AjvClass = Ajv2020 as unknown as any;

export type { Ajv2020 };
