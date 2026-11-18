// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import {
  TURN_IMPORT_MAX_BYTES,
  TURN_IMPORT_MAX_FILES,
  _resetTurnImportsForTesting,
  chargeTurnImport,
} from "../../../src/services/chat-import-budget.ts";

describe("chargeTurnImport", () => {
  beforeEach(() => _resetTurnImportsForTesting());
  // The counters live in the platform limiter, which is Redis in CI: a turn id per test, so no
  // test reads another's counts.
  let turn = "";
  beforeEach(() => {
    turn = `turn_${crypto.randomUUID()}`;
  });

  const fill = async (turnId: string, count: number) => {
    for (let i = 0; i < count; i++) await chargeTurnImport(turnId, 1);
  };

  it("allows a turn up to the file cap, then refuses the next import with a 413", async () => {
    await fill(turn, TURN_IMPORT_MAX_FILES);
    await expect(chargeTurnImport(turn, 1)).rejects.toMatchObject({
      status: 413,
      code: "turn_import_limit",
    });
  });

  it("refuses an import that would pass the byte cap, and keeps the room it leaves", async () => {
    await chargeTurnImport(turn, TURN_IMPORT_MAX_BYTES - 10);
    await expect(chargeTurnImport(turn, 11)).rejects.toMatchObject({
      code: "turn_import_limit",
    });
    // The refused import took neither a file nor a byte.
    await expect(chargeTurnImport(turn, 10)).resolves.toBeFunction();
  });

  it("counts each turn on its own", async () => {
    await fill(turn, TURN_IMPORT_MAX_FILES);
    await expect(chargeTurnImport(`${turn}_other`, 1)).resolves.toBeFunction();
  });

  it("gives the charge back for an import that failed to store", async () => {
    await fill(turn, TURN_IMPORT_MAX_FILES - 1);
    const refund = await chargeTurnImport(turn, 1);
    await refund();
    await expect(chargeTurnImport(turn, 1)).resolves.toBeFunction();
  });

  it("surfaces a limiter failure as itself: no refund, no quota message", async () => {
    const failure = new Error("redis down");
    let rewards = 0;
    _resetTurnImportsForTesting({
      create: () =>
        ({
          consume: async () => {
            throw failure;
          },
          reward: async () => {
            rewards += 1;
          },
        }) as unknown as RateLimiterAbstract,
    });
    await expect(chargeTurnImport(turn, 1)).rejects.toBe(failure);
    expect(rewards).toBe(0);
  });
});
