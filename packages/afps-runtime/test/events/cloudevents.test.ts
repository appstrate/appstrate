// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildCloudEventEnvelope } from "../../src/events/cloudevents.ts";
import type { RunEvent } from "@afps/types";

function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
  return { type, timestamp: 1714000000000, runId: "run_abc", ...extra };
}

describe("buildCloudEventEnvelope", () => {
  it("builds a valid CloudEvents 1.0 envelope for a canonical event", () => {
    const env = buildCloudEventEnvelope({
      event: event("memory.added", { content: "hi" }),
      sequence: 3,
      id: "01HXYZ000000000000000000",
      nowMs: 1714000000000,
    });
    expect(env).toEqual({
      specversion: "1.0",
      type: "memory.added",
      source: "/afps/runs/run_abc",
      id: "01HXYZ000000000000000000",
      time: "2024-04-24T23:06:40.000Z",
      datacontenttype: "application/json",
      data: { content: "hi" },
      sequence: 3,
    });
  });

  it("mirrors the RunEvent type verbatim (no rewriting)", () => {
    const mappings: readonly string[] = [
      "memory.added",
      "state.set",
      "output.emitted",
      "report.appended",
      "log.written",
      "@my-org/audit.logged",
    ];
    for (const type of mappings) {
      const env = buildCloudEventEnvelope({
        event: event(type),
        sequence: 0,
        id: "id",
        nowMs: 0,
      });
      expect(env.type).toBe(type);
    }
  });

  it("strips envelope fields (type, timestamp, runId, toolCallId) from the data payload", () => {
    const env = buildCloudEventEnvelope({
      event: {
        type: "output.emitted",
        timestamp: 1714000000000,
        runId: "r",
        toolCallId: "tc_1",
        data: { count: 42 },
      },
      sequence: 1,
      id: "id",
    });
    expect(env.data).toEqual({ data: { count: 42 } });
    expect((env.data as Record<string, unknown>).type).toBeUndefined();
    expect((env.data as Record<string, unknown>).timestamp).toBeUndefined();
    expect((env.data as Record<string, unknown>).runId).toBeUndefined();
    expect((env.data as Record<string, unknown>).toolCallId).toBeUndefined();
  });

  it("preserves third-party payload fields verbatim", () => {
    const env = buildCloudEventEnvelope({
      event: event("@scope/custom.verb", { actor: "u_1", nested: { n: 2 } }),
      sequence: 0,
      id: "id",
    });
    expect(env.data).toEqual({ actor: "u_1", nested: { n: 2 } });
  });

  it("uses event.timestamp as default nowMs", () => {
    const env = buildCloudEventEnvelope({
      event: event("log.written", { level: "info", message: "x" }),
      sequence: 0,
      id: "id",
    });
    expect(env.time).toBe("2024-04-24T23:06:40.000Z");
  });
});
