// SPDX-License-Identifier: Apache-2.0

/**
 * An inline turn's usage row is written after the turn's own persistence signal, so the
 * conversation detail (which sums the ledger) is signalled again once the row is in.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { ChatUsageRecord } from "@appstrate/core/chat-contract";
import { recordTurnUsage } from "../src/chat-stream.ts";
import { logger } from "../src/logger.ts";

const RECORD: ChatUsageRecord = {
  orgId: "org_usage",
  userId: "user_usage",
  chatSessionId: "chs_usage",
  presetId: "preset_usage",
  modelId: "claude-sonnet-4-5",
  apiShape: "anthropic-messages",
  inputTokens: 10,
  outputTokens: 5,
  cost: null,
  credentialId: "cred_usage",
  durationMs: 1,
};

function deferredWrite() {
  let settle: { resolve: () => void; reject: (err: Error) => void } | undefined;
  const write = (_record: ChatUsageRecord) =>
    new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
  return { write, settle: () => settle! };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("recordTurnUsage", () => {
  it("signals the conversation once the row is written, not before", async () => {
    const notified: unknown[][] = [];
    const { write, settle } = deferredWrite();
    recordTurnUsage(RECORD, write, (...args) => notified.push(args));
    await flush();
    expect(notified).toEqual([]);

    settle().resolve();
    await flush();
    expect(notified).toEqual([["chs_usage", "org_usage", "user_usage"]]);
  });

  it("signals nothing for a turn with no conversation", async () => {
    const notified: unknown[][] = [];
    recordTurnUsage(
      { ...RECORD, chatSessionId: null },
      async () => {},
      (...args) => notified.push(args),
    );
    await flush();
    expect(notified).toEqual([]);
  });

  it("signals nothing, and logs, when the write failed", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const notified: unknown[][] = [];
    const { write, settle } = deferredWrite();
    recordTurnUsage(RECORD, write, (...args) => notified.push(args));
    await flush();
    settle().reject(new Error("ledger down"));
    await flush();
    expect(notified).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never throws, and logs, when the write throws synchronously", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const notified: unknown[][] = [];
    const write = (): Promise<void> => {
      throw new Error("ledger unreachable");
    };
    expect(() => recordTurnUsage(RECORD, write, (...args) => notified.push(args))).not.toThrow();
    await flush();
    expect(notified).toEqual([]);
    expect(warn).toHaveBeenCalledWith("chat usage metering failed", {
      err: "Error: ledger unreachable",
    });
    warn.mockRestore();
  });
});
