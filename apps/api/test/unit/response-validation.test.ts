// SPDX-License-Identifier: Apache-2.0

/**
 * The test harness's response-contract middleware on a proxy: a response the proxy relays from
 * its upstream is checked against the operation's documented `default`, never skipped.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createResponseValidationMiddleware } from "../helpers/response-validation.ts";

const spec = {
  paths: {
    "/proxy": {
      post: {
        responses: {
          "200": { content: { "application/json": { schema: { type: "object" } } } },
          default: { content: { "application/json": { schema: { type: "object" } } } },
        },
      },
    },
  },
};

/** The status the harness answers for a proxy response `status`/`body`, relayed or not. */
async function answer(status: number, body: unknown, relayed: boolean): Promise<number> {
  const app = new Hono();
  app.use("*", createResponseValidationMiddleware(spec));
  app.onError(() => new Response("contract breach", { status: 500 }));
  app.post("/proxy", () =>
    Response.json(body, {
      status,
      headers: relayed ? { "Proxy-Status": `appstrate; received-status=${status}` } : {},
    }),
  );
  return (await app.request("/proxy", { method: "POST" })).status;
}

describe("response-contract middleware — relayed responses", () => {
  it("accepts a relayed upstream error the default documents, whatever its status", async () => {
    expect(await answer(418, { error: "teapot" }, true)).toBe(418);
    expect(await answer(201, { id: "x" }, true)).toBe(201);
  });

  it("validates a relayed error against the default instead of skipping it", async () => {
    expect(await answer(418, ["not", "an", "object"], true)).toBe(500);
  });

  it("still refuses an undeclared status the proxy produced itself", async () => {
    expect(await answer(418, { error: "teapot" }, false)).toBe(500);
  });
});
