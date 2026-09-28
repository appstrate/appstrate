// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

/** The integration package id an `integrations.{packageId}` error field names. */
export function integrationIdOfField(field: string): string {
  return field.slice("integrations.".length);
}

/**
 * The integrations a `409 missing_integration_connection` asks a connection
 * choice for — its `must_choose_connection` items. A schedule write answers
 * with exactly those when a fire could not decide alone. Empty for any other
 * error.
 */
export function mustChooseIntegrationIds(err: unknown): string[] {
  if (!(err instanceof ApiError) || err.code !== "missing_integration_connection") return [];
  // `details` is typed as an open record; this code carries the `errors[]` array.
  const items: unknown = err.details;
  if (!Array.isArray(items)) return [];
  return items
    .filter((e) => e?.code === "must_choose_connection" && typeof e.field === "string")
    .map((e: { field: string }) => integrationIdOfField(e.field));
}
