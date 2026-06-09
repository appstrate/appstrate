// SPDX-License-Identifier: Apache-2.0

/**
 * The mcp module contributes no tables — the operation catalog is built
 * in-memory from the live OpenAPI spec, and tool calls dispatch in-process
 * to existing routes. Default-export the empty tuple so the root test
 * preload's auto-discovery treats this module identically to table-owning ones.
 */
export default [] as const;
