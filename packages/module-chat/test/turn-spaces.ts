// SPDX-License-Identifier: Apache-2.0

import type { TurnSpaces } from "../src/pi-chat/mcp-tools.ts";

/** A turn over `spaces` that records nothing and places no file in a space. */
export function inertTurnSpaces(
  spaces: TurnSpaces["spaces"] = [{ id: "spc_1", name: "One", role: "admin", permissions: [] }],
): TurnSpaces {
  return { spaces, touch: async () => {}, fileSpaces: async () => new Set() };
}
