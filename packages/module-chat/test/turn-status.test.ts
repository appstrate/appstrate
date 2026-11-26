// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/turn-status.ts` — how a running turn reads: its clock, its step in progress, and the
 * title a settled reasoning keeps.
 */

import { describe, expect, it } from "bun:test";
import { formatDuration } from "@appstrate/core/format";
import { reasoningTitle, showStep, turnClock, turnStartOf } from "../src/ui/turn-status.ts";
import { testHost } from "./test-host.ts";

const { t } = testHost();

describe("turnClock", () => {
  it("shows nothing before a second, nor without a time", () => {
    expect(turnClock(undefined, "fr")).toBeUndefined();
    expect(turnClock(0, "fr")).toBeUndefined();
    expect(turnClock(999, "fr")).toBeUndefined();
  });

  it("shows whole seconds from a second on, in the host's language", () => {
    expect(turnClock(1000, "en")).toMatch(/^1\ssec$/);
    expect(turnClock(12_900, "fr")).toMatch(/^12\ss$/);
    expect(turnClock(75_400, "fr")).toBe(formatDuration(75_000, "fr"));
  });
});

describe("turnStartOf", () => {
  const asked = { role: "user", createdAt: new Date("2026-11-26T10:00:00.000Z") };
  const answer = { role: "assistant", createdAt: new Date("2026-11-26T10:00:04.000Z") };

  it("counts from the user message before the assistant one, which a streamed swap keeps", () => {
    expect(turnStartOf([asked, answer], 1)).toBe("2026-11-26T10:00:00.000Z");
    const swapped = { role: "assistant", createdAt: new Date("2026-11-26T10:00:05.000Z") };
    expect(turnStartOf([asked, swapped], 1)).toBe("2026-11-26T10:00:00.000Z");
  });

  it("falls back to the message's own creation without a user message before it", () => {
    expect(turnStartOf([answer], 0)).toBe("2026-11-26T10:00:04.000Z");
    expect(turnStartOf([answer, answer], 1)).toBe("2026-11-26T10:00:04.000Z");
  });
});

describe("showStep", () => {
  it("names a tool call as showCall does, with its target", () => {
    const part = { type: "tool-call", toolName: "search", args: { query: "issues" } };
    expect(showStep(part, undefined, t)).toEqual({ label: "tool.name.search", idText: "issues" });
  });

  it("reads anything else as the model thinking", () => {
    expect(showStep({ type: "reasoning" }, undefined, t)).toEqual({ label: "reasoning.running" });
  });
});

describe("reasoningTitle", () => {
  it("is the first line with words, without its markdown", () => {
    expect(reasoningTitle("\n\n**Listing the agents**\n\nThen count them.")).toBe(
      "Listing the agents",
    );
    expect(reasoningTitle("## Plan\nstep")).toBe("Plan");
    expect(reasoningTitle("- Read the [docs](https://x.test) first")).toBe("Read the docs first");
    expect(reasoningTitle("> _Check_ the `list_agents` result")).toBe(
      "Check the list_agents result",
    );
  });

  it("skips lines made of marks alone, and is empty without words", () => {
    expect(reasoningTitle("**\nReal line")).toBe("Real line");
    expect(reasoningTitle("  \n---\n")).toBe("---");
    expect(reasoningTitle(" \n ")).toBe("");
  });
});
