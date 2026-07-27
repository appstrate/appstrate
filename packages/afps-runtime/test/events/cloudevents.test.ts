// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { buildCloudEventEnvelope } from "../../src/events/cloudevents.ts";
import { canonicalEventSchemaUri } from "../../src/events/canonical-event-schemas.ts";
import { CANONICAL_EVENT_TYPES } from "../../src/types/canonical-events.ts";
import { CANONICAL_EVENT_CORPUS } from "../fixtures/canonical-event-corpus.ts";
import type { RunEvent } from "@afps-spec/types";

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
      dataschema: "https://schemas.afps.dev/v0/events/memory.added.schema.json",
      sequence: 3,
    });
  });

  it("mirrors the RunEvent type verbatim (no rewriting)", () => {
    const mappings: readonly string[] = [
      "memory.added",
      "pinned.set",
      "output.emitted",
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

  it("stamps dataschema for every canonical event type", () => {
    // What is under test here is the WIRING — that a well-formed canonical
    // event comes out carrying the registry's URI for its type. The URI
    // literals themselves are pinned once, in
    // `canonical-event-schemas.test.ts` ("addresses AFPS events on the spec
    // host and appstrate.* on the vendor host"); re-listing all seven here
    // would be a second table to keep in sync, not a second check.
    for (const type of CANONICAL_EVENT_TYPES) {
      const fixture = CANONICAL_EVENT_CORPUS.find((f) => f.event.type === type && f.valid);
      if (fixture === undefined) throw new Error(`corpus has no valid fixture for ${type}`);
      const env = buildCloudEventEnvelope({ event: fixture.event, sequence: 0, id: "id" });
      expect({ type, dataschema: env.dataschema }).toEqual({
        type,
        dataschema: canonicalEventSchemaUri(type),
      });
    }
  });

  it("omits dataschema for third-party events (unknown payload shape)", () => {
    const env = buildCloudEventEnvelope({
      event: event("@scope/custom.verb", { actor: "u_1" }),
      sequence: 0,
      id: "id",
    });
    expect(env.dataschema).toBeUndefined();
    expect("dataschema" in env).toBe(false);
  });

  it("omits dataschema for a canonical type carrying a tampered payload", () => {
    // Emitting a schema URI the payload would fail is a false assertion —
    // the attribute is dropped instead.
    const env = buildCloudEventEnvelope({
      event: event("memory.added", { content: 42 }),
      sequence: 0,
      id: "id",
    });
    expect(env.dataschema).toBeUndefined();
    expect(env.data).toEqual({ content: 42 });
  });

  it("keeps dataschema additive — no existing attribute changes", () => {
    const canonical = buildCloudEventEnvelope({
      event: event("log.written", { level: "info", message: "x" }),
      sequence: 7,
      id: "id",
    });
    const thirdParty = buildCloudEventEnvelope({
      event: event("@scope/custom.verb", { level: "info", message: "x" }),
      sequence: 7,
      id: "id",
    });
    const { dataschema: _dropped, ...withoutDataschema } = canonical;
    expect(withoutDataschema).toEqual({ ...thirdParty, type: "log.written" });
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
