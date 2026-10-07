// SPDX-License-Identifier: Apache-2.0

/** `executeCalls` (multi-call envelope) behaviour that the route cannot reach without waiting. */

import { describe, it, expect } from "bun:test";
import { executeCalls } from "../../../src/services/credential-proxy/calls.ts";

const common = {
  orgId: "org",
  spaceId: "spc_x",
  actor: { type: "user" as const, id: "u" },
  integrationId: "@x/y",
};

describe("executeCalls", () => {
  it("starts no call once the envelope's time budget is spent", async () => {
    const sent: string[] = [];
    const proxy = (async (input: { target: string }) => {
      sent.push(input.target);
      return {
        connectionId: "c1",
        redactedHost: "api.example.com",
        status: 200,
        headers: new Headers(),
        body: null,
      };
    }) as unknown as Parameters<typeof executeCalls>[0]["proxy"];

    const outcomes = await executeCalls({
      calls: [
        { method: "GET", target: "https://api.example.com/1" },
        { method: "GET", target: "https://api.example.com/2" },
      ],
      common,
      maxResponseBytes: 1024,
      proxy,
      startDeadlineMs: -1,
    });

    // The first call always runs (it decides envelope-level failures); the rest are not sent.
    expect(sent).toEqual(["https://api.example.com/1"]);
    expect(outcomes.map((o) => o.result.status)).toEqual([200, 503]);
    expect("error" in outcomes[1]!.result && outcomes[1]!.result.error.code).toBe("not_attempted");
  });
});
