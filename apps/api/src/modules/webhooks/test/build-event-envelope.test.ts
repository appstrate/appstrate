// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildEventEnvelope } from "../service.ts";

describe("buildEventEnvelope", () => {
  it("builds a valid event envelope in full mode", () => {
    const { eventId, payload } = buildEventEnvelope({
      eventType: "run.success",
      run: {
        id: "exec_123",
        status: "success",
        result: "output data",
        input: "input data",
      },
      payloadMode: "full",
    });

    expect(eventId).toStartWith("evt_");
    expect(payload.type).toBe("run.success");
    expect(payload.object).toBe("event");
    expect(payload.id).toBe(eventId);

    const data = payload.data as { object: Record<string, unknown> };
    expect(data.object.result).toBe("output data");
    expect(data.object.input).toBe("input data");
  });

  it("strips result and input in summary mode", () => {
    const { payload } = buildEventEnvelope({
      eventType: "run.success",
      run: { id: "exec_123", status: "success", result: "output", input: "input" },
      payloadMode: "summary",
    });

    const data = payload.data as { object: Record<string, unknown> };
    expect(data.object.result).toBeUndefined();
    expect(data.object.input).toBeUndefined();
    expect(data.object.status).toBe("success");
  });

  it("surfaces inline-run marker as package: { ephemeral: true } in the envelope", () => {
    // Mirrors the payload the webhooks module constructs from
    // RunStatusChangeParams.packageEphemeral — downstream consumers
    // must be able to branch on package.ephemeral without an extra DB call.
    const { payload } = buildEventEnvelope({
      eventType: "run.success",
      run: {
        id: "run_123",
        status: "success",
        packageId: "@inline/r-abc",
        package: { ephemeral: true },
      },
      payloadMode: "full",
    });

    const data = payload.data as { object: Record<string, unknown> };
    expect(data.object.package).toEqual({ ephemeral: true });
  });

  it("omits the package marker for classic (non-inline) runs", () => {
    const { payload } = buildEventEnvelope({
      eventType: "run.success",
      run: { id: "run_123", status: "success", packageId: "@acme/agent" },
      payloadMode: "full",
    });

    const data = payload.data as { object: Record<string, unknown> };
    expect(data.object.package).toBeUndefined();
  });
});
