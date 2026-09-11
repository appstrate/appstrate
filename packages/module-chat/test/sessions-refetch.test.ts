// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { sessionsRefetchInterval } from "../src/ui/use-sessions.ts";
import type { SessionSummary } from "../src/ui/sessions.ts";

const row = (id: string, generating: boolean): SessionSummary => ({
  id,
  title: null,
  generating,
  unread: false,
  updatedAt: "2026-09-02T10:00:00.000Z",
});

const query = (data: SessionSummary[] | undefined) => ({ state: { data } });

describe("sessionsRefetchInterval", () => {
  it("uses the generating backstop while any row is generating", () => {
    expect(sessionsRefetchInterval(query([row("a", false), row("b", true)]))).toBe(10_000);
  });

  it("uses the slow safety net when every row is idle", () => {
    expect(sessionsRefetchInterval(query([row("a", false), row("b", false)]))).toBe(60_000);
  });

  it("uses the slow safety net before any data has landed", () => {
    expect(sessionsRefetchInterval(query(undefined))).toBe(60_000);
    expect(sessionsRefetchInterval(query([]))).toBe(60_000);
  });
});
