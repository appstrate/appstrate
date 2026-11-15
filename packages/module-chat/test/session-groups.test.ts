// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { groupSessionsByDate, sessionGroupKey } from "../src/ui/session-groups.ts";
import type { SessionSummary } from "../src/ui/sessions.ts";

// Wednesday 2026-11-18 15:30 local.
const now = new Date(2026, 10, 18, 15, 30);
const at = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

function row(id: string, updatedAt: string): SessionSummary {
  return { id, title: id, generating: false, unread: false, updatedAt };
}

describe("sessionGroupKey", () => {
  it("cuts at local midnight", () => {
    expect(sessionGroupKey(at(2026, 11, 18, 0, 0), now)).toBe("today");
    expect(sessionGroupKey(at(2026, 11, 17, 23, 59), now)).toBe("yesterday");
    expect(sessionGroupKey(at(2026, 11, 17, 0, 0), now)).toBe("yesterday");
    expect(sessionGroupKey(at(2026, 11, 16, 23, 59), now)).toBe("week");
  });

  it("covers the previous 7 and 30 days by calendar day", () => {
    expect(sessionGroupKey(at(2026, 11, 11, 0, 0), now)).toBe("week");
    expect(sessionGroupKey(at(2026, 11, 10, 23, 59), now)).toBe("month");
    expect(sessionGroupKey(at(2026, 10, 19, 0, 0), now)).toBe("month");
    expect(sessionGroupKey(at(2026, 10, 18, 23, 59), now)).toBe("older");
  });

  it("treats the future as today and garbage as older", () => {
    expect(sessionGroupKey(at(2026, 11, 20), now)).toBe("today");
    expect(sessionGroupKey("", now)).toBe("older");
  });
});

describe("groupSessionsByDate", () => {
  it("returns only non-empty groups, in display order, keeping row order", () => {
    const groups = groupSessionsByDate(
      [
        row("a", at(2026, 11, 18, 9)),
        row("b", at(2026, 11, 18, 8)),
        row("c", at(2026, 11, 17, 12)),
        row("d", at(2026, 1, 1)),
      ],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(["today", "yesterday", "older"]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("is empty for no sessions", () => {
    expect(groupSessionsByDate([], now)).toEqual([]);
  });
});
