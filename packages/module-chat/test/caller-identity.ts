// SPDX-License-Identifier: Apache-2.0

/** The caller identity `formatCallerContext` renders, built for a test case. */

import type { formatCallerContext } from "../src/prompt.ts";

type CallerIdentity = Parameters<typeof formatCallerContext>[0];

/** An identity given loosely: what a case does not name is not known (`null`). */
export function callerIdentity(raw: {
  user?: { name?: string; email?: string };
  org?: { role?: string; name?: string; slug?: string };
}): CallerIdentity {
  return {
    user: { name: raw.user?.name ?? null, email: raw.user?.email ?? null },
    org: {
      role: raw.org?.role ?? null,
      name: raw.org?.name ?? null,
      slug: raw.org?.slug ?? null,
    },
  };
}
