// SPDX-License-Identifier: Apache-2.0

/**
 * The canonical RFC 8707 resource identifier for the inbound MCP server.
 *
 * This single value MUST be used identically in three places or audience
 * binding silently breaks:
 *   1. the PRM `resource` field (what a client echoes back as `resource`),
 *   2. the authorization server's `validAudiences` (so it accepts that
 *      `resource` and stamps it as the token `aud`),
 *   3. the resource server's audience check on `/api/mcp`.
 *
 * Derived from the configured public URL (`APP_URL`) rather than the request
 * origin so the identifier is stable across reverse-proxied hosts — the token
 * `aud` a client obtained yesterday still matches today regardless of which
 * edge host served the request.
 *
 * Lives in its own dependency-free file so the oidc module can import it to
 * extend `validAudiences` without pulling the MCP router (and its transitive
 * MCP SDK imports) into the auth-plugin construction path.
 */

import { getEnv } from "@appstrate/env";

/** Path of the inbound MCP endpoint, relative to the platform origin. */
export const MCP_RESOURCE_PATH = "/api/mcp";

/** Canonical resource URI, e.g. `https://instance.example/api/mcp`. */
export function getMcpResourceUri(): string {
  // Tolerate a trailing slash on APP_URL so the audience is byte-stable.
  return `${getEnv().APP_URL.replace(/\/+$/, "")}${MCP_RESOURCE_PATH}`;
}
