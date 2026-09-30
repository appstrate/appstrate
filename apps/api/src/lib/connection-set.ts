// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";

/**
 * A connection set on every write — pins, org defaults, launch overrides: 1..
 * {@link MAX_CONNECTIONS_PER_INTEGRATION} uuids, caller's order kept, no repeat; lowercased
 * because the resolver matches what Postgres returns and `z.uuid()` accepts upper case.
 */
export const connectionIdSetSchema = z
  .array(z.uuid())
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
