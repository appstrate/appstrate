// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "bun:test";
import {
  TURN_IMPORT_MAX_BYTES,
  TURN_IMPORT_MAX_FILES,
  _resetTurnImportsForTesting,
  chargeTurnImport,
} from "../../../src/services/chat-import-budget.ts";

describe("chargeTurnImport", () => {
  beforeEach(() => _resetTurnImportsForTesting());

  it("allows a turn up to the file cap, then refuses the next import with a 413", () => {
    for (let i = 0; i < TURN_IMPORT_MAX_FILES; i++) chargeTurnImport("turn_a", 1);
    expect(() => chargeTurnImport("turn_a", 1)).toThrow(
      expect.objectContaining({ status: 413, code: "turn_import_limit" }),
    );
  });

  it("refuses an import that would pass the byte cap, and keeps the room it leaves", () => {
    chargeTurnImport("turn_a", TURN_IMPORT_MAX_BYTES - 10);
    expect(() => chargeTurnImport("turn_a", 11)).toThrow(
      expect.objectContaining({ code: "turn_import_limit" }),
    );
    expect(() => chargeTurnImport("turn_a", 10)).not.toThrow();
  });

  it("counts each turn on its own", () => {
    for (let i = 0; i < TURN_IMPORT_MAX_FILES; i++) chargeTurnImport("turn_a", 1);
    expect(() => chargeTurnImport("turn_b", 1)).not.toThrow();
  });

  it("gives the charge back for an import that failed to store", () => {
    for (let i = 0; i < TURN_IMPORT_MAX_FILES - 1; i++) chargeTurnImport("turn_a", 1);
    const refund = chargeTurnImport("turn_a", 1);
    refund();
    expect(() => chargeTurnImport("turn_a", 1)).not.toThrow();
  });

  it("forgets a turn once its entry has expired", () => {
    const now = Date.now();
    for (let i = 0; i < TURN_IMPORT_MAX_FILES; i++) chargeTurnImport("turn_a", 1, now);
    expect(() => chargeTurnImport("turn_a", 1, now + 31 * 60_000)).not.toThrow();
  });
});
