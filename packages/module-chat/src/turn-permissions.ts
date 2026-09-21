// SPDX-License-Identifier: Apache-2.0

/**
 * The permissions a chat turn acts with: the caller's own, minus `agents:write`
 * when agent authoring is off. The turn's MCP loopback token is minted from this
 * set, so the platform's existing guards refuse creating or editing an agent and
 * composing an inline one (which needs `agents:write` AND `agents:run`); the
 * switch can only narrow the caller's grants, never widen them.
 */
export function turnPermissions(permissions: Iterable<string>, authoring: boolean): string[] {
  const granted = [...permissions];
  return authoring ? granted : granted.filter((permission) => permission !== "agents:write");
}
