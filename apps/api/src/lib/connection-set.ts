// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";

/**
 * A connection set on the wire: 1..{@link MAX_CONNECTIONS_PER_INTEGRATION} ids,
 * caller's order kept, no repeat. Lowercased because the resolver looks a pick
 * up by what Postgres returns, and `z.uuid()` accepts upper case.
 */
export function connectionSetSchema(id: z.ZodType<string>) {
  return z
    .array(id)
    .min(1)
    .max(MAX_CONNECTIONS_PER_INTEGRATION)
    .transform((ids, ctx) => {
      const folded = ids.map((value) => value.toLowerCase());
      if (new Set(folded).size !== folded.length) {
        ctx.addIssue({ code: "custom", message: "must not repeat a connection id" });
        return z.NEVER;
      }
      return folded;
    });
}

/** Pins and org defaults: stored in a `uuid[]`, so every id is a uuid. */
export const connectionIdSetSchema = connectionSetSchema(z.uuid());
