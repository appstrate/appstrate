// SPDX-License-Identifier: Apache-2.0

/**
 * The codex twin of `concurrency.test.ts`. Both gates now wrap the shared
 * {@link ../src/concurrency-gate.ts} factory, so this file covers BOTH the
 * codex-specific re-export (env knob `CHAT_CODEX_MAX_CONCURRENCY`) and the
 * factory in isolation (counter independence + idempotent release).
 */

import { describe, expect, it, afterEach } from "bun:test";
import {
  acquireCodexSlot,
  activeCodexSlots,
  codexMaxConcurrency,
} from "../src/codex-agent/concurrency.ts";
import { createConcurrencyGate } from "../src/concurrency-gate.ts";

// The gate is module-level process state; each test fully releases what it
// takes and restores the env knob so cases don't bleed into one another.
afterEach(() => {
  delete process.env.CHAT_CODEX_MAX_CONCURRENCY;
});

describe("codexMaxConcurrency", () => {
  it("defaults to 6 when unset", () => {
    delete process.env.CHAT_CODEX_MAX_CONCURRENCY;
    expect(codexMaxConcurrency()).toBe(6);
  });

  it("honours a positive integer override", () => {
    process.env.CHAT_CODEX_MAX_CONCURRENCY = "3";
    expect(codexMaxConcurrency()).toBe(3);
  });

  it("falls back to the default on non-numeric / non-positive input", () => {
    process.env.CHAT_CODEX_MAX_CONCURRENCY = "nope";
    expect(codexMaxConcurrency()).toBe(6);
    process.env.CHAT_CODEX_MAX_CONCURRENCY = "0";
    expect(codexMaxConcurrency()).toBe(6);
    process.env.CHAT_CODEX_MAX_CONCURRENCY = "-4";
    expect(codexMaxConcurrency()).toBe(6);
  });
});

describe("acquireCodexSlot", () => {
  it("hands out slots up to the cap, then returns null until one frees", () => {
    process.env.CHAT_CODEX_MAX_CONCURRENCY = "2";
    expect(activeCodexSlots()).toBe(0);

    const a = acquireCodexSlot();
    const b = acquireCodexSlot();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(activeCodexSlots()).toBe(2);

    // At capacity → refused.
    expect(acquireCodexSlot()).toBeNull();

    // Free one → a new acquire succeeds again.
    a!.release();
    expect(activeCodexSlots()).toBe(1);
    const c = acquireCodexSlot();
    expect(c).not.toBeNull();
    expect(activeCodexSlots()).toBe(2);

    b!.release();
    c!.release();
    expect(activeCodexSlots()).toBe(0);
  });

  it("release is idempotent — a double release does not under-count the gate", () => {
    process.env.CHAT_CODEX_MAX_CONCURRENCY = "1";
    const a = acquireCodexSlot();
    expect(a).not.toBeNull();
    a!.release();
    a!.release(); // no-op
    expect(activeCodexSlots()).toBe(0);

    // The gate still reflects a true single slot (not -1 capacity).
    const b = acquireCodexSlot();
    expect(b).not.toBeNull();
    expect(acquireCodexSlot()).toBeNull();
    b!.release();
    expect(activeCodexSlots()).toBe(0);
  });
});

describe("createConcurrencyGate (shared factory)", () => {
  it("reads its own env var and falls back to the supplied default", () => {
    const gate = createConcurrencyGate("CHAT_TEST_GATE_MAX", 4);
    delete process.env.CHAT_TEST_GATE_MAX;
    expect(gate.max()).toBe(4);
    process.env.CHAT_TEST_GATE_MAX = "2";
    expect(gate.max()).toBe(2);
    process.env.CHAT_TEST_GATE_MAX = "garbage";
    expect(gate.max()).toBe(4);
    delete process.env.CHAT_TEST_GATE_MAX;
  });

  it("two gates keep independent counters (no shared module state)", () => {
    const g1 = createConcurrencyGate("CHAT_TEST_GATE_A", 1);
    const g2 = createConcurrencyGate("CHAT_TEST_GATE_B", 1);

    const s1 = g1.acquire();
    expect(s1).not.toBeNull();
    expect(g1.acquire()).toBeNull(); // g1 saturated
    // g2 is untouched by g1's acquisition.
    expect(g2.active()).toBe(0);
    const s2 = g2.acquire();
    expect(s2).not.toBeNull();

    s1!.release();
    s2!.release();
    expect(g1.active()).toBe(0);
    expect(g2.active()).toBe(0);
  });

  it("acquire returns null exactly at capacity and recovers after release", () => {
    const gate = createConcurrencyGate("CHAT_TEST_GATE_CAP", 2);
    const a = gate.acquire();
    const b = gate.acquire();
    expect(gate.acquire()).toBeNull();
    expect(gate.active()).toBe(2);
    a!.release();
    const c = gate.acquire();
    expect(c).not.toBeNull();
    b!.release();
    c!.release();
    expect(gate.active()).toBe(0);
  });
});
