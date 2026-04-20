// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildCloudEventEnvelope, type CloudEventType } from "../../src/events/cloudevents.ts";
import type { AfpsEvent } from "../../src/types/afps-event.ts";

describe("buildCloudEventEnvelope", () => {
  it("builds a valid CloudEvents 1.0 envelope for add_memory", () => {
    const env = buildCloudEventEnvelope({
      event: { type: "add_memory", content: "hi" },
      runId: "run_abc",
      sequence: 3,
      id: "01HXYZ000000000000000000",
      nowMs: 1714000000000,
    });
    expect(env).toEqual({
      specversion: "1.0",
      type: "dev.afps.add_memory.v1",
      source: "/afps/runs/run_abc",
      id: "01HXYZ000000000000000000",
      time: "2024-04-24T23:06:40.000Z",
      datacontenttype: "application/json",
      data: { content: "hi" },
      sequence: 3,
    });
  });

  it("maps every AFPS event type to its CloudEvents type", () => {
    const mappings: ReadonlyArray<[AfpsEvent["type"], CloudEventType]> = [
      ["add_memory", "dev.afps.add_memory.v1"],
      ["set_state", "dev.afps.set_state.v1"],
      ["output", "dev.afps.output.v1"],
      ["report", "dev.afps.report.v1"],
      ["log", "dev.afps.log.v1"],
    ];
    for (const [afps, ce] of mappings) {
      const event = sampleEvent(afps);
      const env = buildCloudEventEnvelope({
        event,
        runId: "r",
        sequence: 0,
        id: "id",
        nowMs: 0,
      });
      expect(env.type).toBe(ce);
    }
  });

  it("strips the `type` discriminator from the data payload", () => {
    const env = buildCloudEventEnvelope({
      event: { type: "output", data: { count: 42 } },
      runId: "r",
      sequence: 1,
      id: "id",
    });
    expect(env.data).toEqual({ data: { count: 42 } });
    expect((env.data as Record<string, unknown>).type).toBeUndefined();
  });

  it("uses `Date.now()` as default nowMs", () => {
    const before = Date.now();
    const env = buildCloudEventEnvelope({
      event: { type: "log", level: "info", message: "x" },
      runId: "r",
      sequence: 0,
      id: "id",
    });
    const after = Date.now();
    const envMs = Date.parse(env.time);
    expect(envMs).toBeGreaterThanOrEqual(before);
    expect(envMs).toBeLessThanOrEqual(after);
  });
});

function sampleEvent(type: AfpsEvent["type"]): AfpsEvent {
  switch (type) {
    case "add_memory":
      return { type, content: "x" };
    case "set_state":
      return { type, state: null };
    case "output":
      return { type, data: null };
    case "report":
      return { type, content: "" };
    case "log":
      return { type, level: "info", message: "" };
  }
}
