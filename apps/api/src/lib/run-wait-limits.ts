// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";

/** Room for the response to cross the proxy and reach an MCP client before its request timeout. */
const WAIT_RESPONSE_MARGIN_SECONDS = 5;

/**
 * Ceiling of `GET /api/runs/{id}?wait=`, in seconds, below typical 60 s proxy idle timeouts.
 * Larger values are clamped, not rejected. A leaf, so the OpenAPI spec can interpolate it.
 * An MCP client's getRun?wait=true is one SDK request (DEFAULT_REQUEST_TIMEOUT_MSEC, 60 s,
 * also the usual proxy idle timeout). A change moves the OpenAPI text and the AGENTS.md
 * "Operational Notes & Known Limitations" section.
 */
export const MAX_WAIT_SECONDS = DEFAULT_REQUEST_TIMEOUT_MSEC / 1000 - WAIT_RESPONSE_MARGIN_SECONDS;
