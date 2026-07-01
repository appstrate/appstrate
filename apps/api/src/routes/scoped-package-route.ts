// SPDX-License-Identifier: Apache-2.0

/**
 * Hono route segment for scoped package identifiers split as `:scope/:name`.
 *
 * Route matching sees the raw URL path, so a standards-compliant client that
 * encodes `@scope` as `%40scope` would miss a plain `:scope{@...}` constraint.
 * Accept both spellings, while keeping the same slug grammar as package ids.
 */
export const SCOPED_PACKAGE_ROUTE =
  ":scope{(?:@|%40)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?}/:name{[a-z0-9](?:[a-z0-9-]*[a-z0-9])?}";
