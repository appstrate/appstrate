// SPDX-License-Identifier: Apache-2.0

import { findCause } from "@appstrate/core/error-cause";

/** Both postgres.js and PGlite preserve the failed constraint on the wrapped driver error. */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  return (
    findCause(
      error,
      (cause) =>
        (cause.code === "23503" || cause.code === "23001") &&
        (constraint === undefined || (cause.constraint_name ?? cause.constraint) === constraint),
    ) !== undefined
  );
}
