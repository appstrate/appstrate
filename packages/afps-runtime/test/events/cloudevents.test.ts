// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildCloudEventEnvelope } from "../../src/events/cloudevents.ts";
import type { RunEvent } from "@afps-spec/types";

function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
  return { type, timestamp: 1714000000000, runId: "run_abc", ...extra };
}

describe("buildCloudEventEnvelope", () => {
  it("builds a valid CloudEvents 1.0 envelope for a canonical event", () => {
    const env = buildCloudEventEnvelope({
      event: event("@my-org/audit.logged", { content: "hi" }),
      sequence: 3,
      id: "01HXYZ000000000000000000",
      nowMs: 1714000000000,
    });
    expect(env).toEqual({
      specversion: "1.0",
      type: "@my-org/audit.logged",
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
      "output.emitted",
      "appstrate.progress",
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

  it("never stamps dataschema — not even for a well-formed `output.emitted`", () => {
    // The attribute used to point at `schemas.afps.dev/v0/events/*`. Nothing
    // was served there, and the AFPS RunEvent payload is deliberately open —
    // the spec reserves namespaces, not shapes. Emitting it again is a spec
    // change first (see the module header).
    const env = buildCloudEventEnvelope({
      event: event("output.emitted", { data: { ok: true } }),
      sequence: 0,
      id: "id",
    });
    expect("dataschema" in env).toBe(false);
  });

  it("builds canonical and third-party envelopes identically apart from type", () => {
    // With the stamp gone, canonicality has no effect on the envelope at all.
    const canonical = buildCloudEventEnvelope({
      event: event("appstrate.progress", { message: "x" }),
      sequence: 7,
      id: "id",
    });
    const thirdParty = buildCloudEventEnvelope({
      event: event("@scope/custom.verb", { message: "x" }),
      sequence: 7,
      id: "id",
    });
    expect(canonical).toEqual({ ...thirdParty, type: "appstrate.progress" });
  });

  it("uses event.timestamp as default nowMs", () => {
    const env = buildCloudEventEnvelope({
      event: event("appstrate.progress", { message: "x" }),
      sequence: 0,
      id: "id",
    });
    expect(env.time).toBe("2024-04-24T23:06:40.000Z");
  });
});
