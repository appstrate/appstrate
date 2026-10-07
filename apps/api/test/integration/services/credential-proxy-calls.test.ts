// SPDX-License-Identifier: Apache-2.0

/** `executeCalls` (multi-call envelope) behaviour that the route cannot reach without waiting. */

import { describe, it, expect } from "bun:test";
import { executeCalls } from "../../../src/services/credential-proxy/calls.ts";
import { ProxyCallError } from "../../../src/services/credential-proxy/core.ts";

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

  it("holds the response cap on the encoded envelope, not only on upstream bytes", async () => {
    // 1000 control bytes: valid UTF-8 under the 1024-byte cap, ~6 KB once JSON-escaped.
    const body = "\u0001".repeat(1000);
    const proxy = (async () => ({
      connectionId: "c1",
      redactedHost: "api.example.com",
      status: 200,
      headers: new Headers(),
      body: new Response(body).body,
    })) as unknown as Parameters<typeof executeCalls>[0]["proxy"];

    const outcomes = await executeCalls({
      calls: [{ method: "GET", target: "https://api.example.com/1" }],
      common,
      maxResponseBytes: 1024,
      proxy,
    });

    const result = outcomes[0]!.result;
    expect("body" in result && result.body).toBeNull();
    expect("truncated" in result && result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(outcomes.map((o) => o.result)))).toBeLessThan(1024);
  });

  it("raises an envelope-level failure as-is, keeping the connection it used for the audit", async () => {
    const proxy = (async () => {
      throw new ProxyCallError("credential_unusable", "unusable", "c1");
    }) as unknown as Parameters<typeof executeCalls>[0]["proxy"];

    const err = await executeCalls({
      calls: [{ method: "GET", target: "https://api.example.com/1" }],
      common,
      maxResponseBytes: 1024,
      proxy,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProxyCallError);
    expect((err as ProxyCallError).connectionId).toBe("c1");
  });
});
