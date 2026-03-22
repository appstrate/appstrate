/**
 * Webhook signing and envelope unit tests.
 * Tests pure functions directly — no mocking of the webhooks module itself.
 */

import { describe, test, expect } from "bun:test";

// --- Test signing directly using Bun crypto (same logic as webhooks.ts) ---

async function sign(secret: string, content: string): Promise<string> {
  const key = Buffer.from(secret.replace("whsec_", ""), "base64url");
  const hasher = new Bun.CryptoHasher("sha256", key);
  hasher.update(content);
  return `v1,${Buffer.from(hasher.digest()).toString("base64")}`;
}

async function buildSignedHeaders(
  eventId: string,
  timestamp: number,
  body: string,
  secret: string,
  previousSecret?: string | null,
): Promise<Record<string, string>> {
  const content = `${eventId}.${timestamp}.${body}`;
  const sig = await sign(secret, content);
  let signature = sig;
  if (previousSecret) {
    const prevSig = await sign(previousSecret, content);
    signature = `${sig} ${prevSig}`;
  }
  return {
    "webhook-id": eventId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signature,
    "content-type": "application/json",
  };
}

describe("Standard Webhooks signing", () => {
  test("produces v1 signature with correct headers", async () => {
    const headers = await buildSignedHeaders(
      "evt_123",
      1700000000,
      '{"test":true}',
      "whsec_dGVzdA",
    );

    expect(headers["webhook-id"]).toBe("evt_123");
    expect(headers["webhook-timestamp"]).toBe("1700000000");
    expect(headers["webhook-signature"]).toMatch(/^v1,/);
    expect(headers["content-type"]).toBe("application/json");
  });

  test("includes two signatures during rotation", async () => {
    const headers = await buildSignedHeaders(
      "evt_123",
      1700000000,
      '{"test":true}',
      "whsec_bmV3",
      "whsec_b2xk",
    );

    const sigs = headers["webhook-signature"]!.split(" ");
    expect(sigs).toHaveLength(2);
    expect(sigs[0]).toMatch(/^v1,/);
    expect(sigs[1]).toMatch(/^v1,/);
    expect(sigs[0]).not.toBe(sigs[1]);
  });

  test("same inputs produce deterministic signatures", async () => {
    const h1 = await buildSignedHeaders("evt_1", 100, "body", "whsec_dGVzdA");
    const h2 = await buildSignedHeaders("evt_1", 100, "body", "whsec_dGVzdA");
    expect(h1["webhook-signature"]).toBe(h2["webhook-signature"]);
  });

  test("different secrets produce different signatures", async () => {
    const h1 = await buildSignedHeaders("evt_1", 100, "body", "whsec_dGVzdA");
    const h2 = await buildSignedHeaders("evt_1", 100, "body", "whsec_b3RoZXI");
    expect(h1["webhook-signature"]).not.toBe(h2["webhook-signature"]);
  });
});

// --- Test envelope building (pure function, duplicated from webhooks.ts) ---

function buildEventEnvelope(params: {
  eventType: string;
  execution: Record<string, unknown>;
  payloadMode: "full" | "summary";
}): { eventId: string; payload: Record<string, unknown> } {
  const eventId = `evt_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const execObj: Record<string, unknown> = { ...params.execution, object: "execution" };

  if (params.payloadMode === "summary") {
    delete execObj.result;
    delete execObj.input;
  }

  return {
    eventId,
    payload: {
      id: eventId,
      object: "event",
      type: params.eventType,
      apiVersion: "2026-03-21",
      created: now,
      data: { object: execObj },
    },
  };
}

describe("Event envelope", () => {
  const execution = {
    id: "exec_abc",
    flowId: "@test/flow",
    userId: "usr_1",
    status: "success",
    result: { report: "done" },
    input: { text: "hello" },
    duration: 5000,
    cost: 0.01,
    completedAt: "2026-01-01T00:00:00Z",
  };

  test("full mode includes result and input", () => {
    const { eventId, payload } = buildEventEnvelope({
      eventType: "execution.completed",
      execution,
      payloadMode: "full",
    });

    expect(eventId).toMatch(/^evt_/);
    expect(payload.object).toBe("event");
    expect(payload.type).toBe("execution.completed");
    expect(payload.apiVersion).toBe("2026-03-21");
    expect(typeof payload.created).toBe("number");

    const obj = (payload.data as { object: Record<string, unknown> }).object;
    expect(obj.result).toEqual({ report: "done" });
    expect(obj.input).toEqual({ text: "hello" });
    expect(obj.object).toBe("execution");
  });

  test("summary mode strips result and input", () => {
    const { payload } = buildEventEnvelope({
      eventType: "execution.completed",
      execution,
      payloadMode: "summary",
    });

    const obj = (payload.data as { object: Record<string, unknown> }).object;
    expect(obj.result).toBeUndefined();
    expect(obj.input).toBeUndefined();
    expect(obj.status).toBe("success");
    expect(obj.duration).toBe(5000);
  });

  test("generates unique event IDs", () => {
    const e1 = buildEventEnvelope({
      eventType: "execution.completed",
      execution,
      payloadMode: "full",
    });
    const e2 = buildEventEnvelope({
      eventType: "execution.completed",
      execution,
      payloadMode: "full",
    });
    expect(e1.eventId).not.toBe(e2.eventId);
  });

  test("does not mutate original execution object", () => {
    buildEventEnvelope({ eventType: "execution.completed", execution, payloadMode: "summary" });
    expect(execution.result).toEqual({ report: "done" }); // unchanged
    expect(execution.input).toEqual({ text: "hello" }); // unchanged
  });
});
