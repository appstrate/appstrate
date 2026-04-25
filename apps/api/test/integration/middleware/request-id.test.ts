// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";

const app = getTestApp();

const VALID_TRACE = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

describe("Request-Id middleware — base behaviour", () => {
  it("emits a Request-Id header on every response", async () => {
    const res = await app.request("/api/openapi.json");
    expect(res.headers.get("Request-Id")).toMatch(/^req_[0-9a-f-]+$/);
  });
});

describe("Request-Id middleware — W3C Trace Context propagation", () => {
  it("echoes a valid inbound traceparent header back on the response", async () => {
    const res = await app.request("/api/openapi.json", {
      headers: { traceparent: VALID_TRACE },
    });
    expect(res.headers.get("traceparent")).toBe(VALID_TRACE);
  });

  it("does NOT echo malformed traceparent headers (drops silently)", async () => {
    const res = await app.request("/api/openapi.json", {
      headers: { traceparent: "garbage" },
    });
    expect(res.headers.get("traceparent")).toBeNull();
  });

  it("does NOT echo all-zero forbidden traceparent (W3C §3.2)", async () => {
    const res = await app.request("/api/openapi.json", {
      headers: {
        traceparent: "00-00000000000000000000000000000000-b7ad6b7169203331-01",
      },
    });
    expect(res.headers.get("traceparent")).toBeNull();
  });

  it("does NOT echo unsupported version traceparent", async () => {
    const res = await app.request("/api/openapi.json", {
      headers: {
        traceparent: "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      },
    });
    expect(res.headers.get("traceparent")).toBeNull();
  });

  it("omits traceparent on the response when no inbound header is sent", async () => {
    const res = await app.request("/api/openapi.json");
    expect(res.headers.get("traceparent")).toBeNull();
  });
});
