// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";

/**
 * A connection set on every write: `min`..{@link MAX_CONNECTIONS_PER_INTEGRATION} uuids, caller's
 * order kept, no repeat; lowercased because the resolver matches what Postgres returns and
 * `z.uuid()` accepts upper case.
 */
function connectionIdSet(min: number) {
  return z
    .array(z.uuid())
    .min(min)
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

/** Pins and launch overrides. `[]` is "explicitly none": the layer wins and binds no connection. */
export const connectionIdSetSchema = connectionIdSet(0);

/** Org defaults: a default naming no connection would be a second spelling of "no default". */
export const nonEmptyConnectionIdSetSchema = connectionIdSet(1);
