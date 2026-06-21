// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, afterEach } from "bun:test";
import {
  acquireClaudeSlot,
  activeClaudeSlots,
  claudeMaxConcurrency,
} from "../src/claude-agent/concurrency.ts";

// The gate is module-level process state; each test fully releases what it
// takes and restores the env knob so cases don't bleed into one another.
afterEach(() => {
  delete process.env.CHAT_CLAUDE_MAX_CONCURRENCY;
});

describe("claudeMaxConcurrency", () => {
  it("defaults to 6 when unset", () => {
    delete process.env.CHAT_CLAUDE_MAX_CONCURRENCY;
    expect(claudeMaxConcurrency()).toBe(6);
  });

  it("honours a positive integer override", () => {
    process.env.CHAT_CLAUDE_MAX_CONCURRENCY = "3";
    expect(claudeMaxConcurrency()).toBe(3);
  });

  it("falls back to the default on non-numeric / non-positive input", () => {
    process.env.CHAT_CLAUDE_MAX_CONCURRENCY = "nope";
    expect(claudeMaxConcurrency()).toBe(6);
    process.env.CHAT_CLAUDE_MAX_CONCURRENCY = "0";
    expect(claudeMaxConcurrency()).toBe(6);
    process.env.CHAT_CLAUDE_MAX_CONCURRENCY = "-4";
    expect(claudeMaxConcurrency()).toBe(6);
  });
});

describe("acquireClaudeSlot", () => {
  it("hands out slots up to the cap, then returns null until one frees", () => {
    process.env.CHAT_CLAUDE_MAX_CONCURRENCY = "2";
    expect(activeClaudeSlots()).toBe(0);

    const a = acquireClaudeSlot();
    const b = acquireClaudeSlot();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(activeClaudeSlots()).toBe(2);

    // At capacity → refused.
    expect(acquireClaudeSlot()).toBeNull();

    // Free one → a new acquire succeeds again.
    a!.release();
    expect(activeClaudeSlots()).toBe(1);
    const c = acquireClaudeSlot();
    expect(c).not.toBeNull();
    expect(activeClaudeSlots()).toBe(2);

    b!.release();
    c!.release();
    expect(activeClaudeSlots()).toBe(0);
  });

  it("release is idempotent — a double release does not under-count the gate", () => {
    process.env.CHAT_CLAUDE_MAX_CONCURRENCY = "1";
    const a = acquireClaudeSlot();
    expect(a).not.toBeNull();
    a!.release();
    a!.release(); // no-op
    expect(activeClaudeSlots()).toBe(0);

    // The gate still reflects a true single slot (not -1 capacity).
    const b = acquireClaudeSlot();
    expect(b).not.toBeNull();
    expect(acquireClaudeSlot()).toBeNull();
    b!.release();
    expect(activeClaudeSlots()).toBe(0);
  });
});
