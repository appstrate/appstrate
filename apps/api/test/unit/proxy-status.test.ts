// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import {
  proxyProblem,
  proxyStatusMarker,
  upstreamFailureDetail,
  type ProxyProblemCode,
} from "../../src/lib/proxy-status.ts";
import type { AppEnv } from "../../src/types/index.ts";

/** A proxy route answering `proxyProblem(code)`, behind the marker, as the real routes are. */
async function answer(code: ProxyProblemCode): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => errorHandler(err, c));
  app.use("*", proxyStatusMarker());
  app.all("*", () => {
    throw proxyProblem(code, "detail");
  });
  return app.request("http://inst.test/api/credential-proxy/proxy");
}

describe("proxyProblem", () => {
  it.each([
    ["unauthorized_target", 403, "appstrate; error=http_request_denied"],
    ["blocked_target", 403, "appstrate; error=destination_ip_prohibited"],
    ["credential_not_found", 404, "appstrate; error=proxy_internal_response"],
    ["unresolved_placeholder", 400, "appstrate; error=proxy_internal_response"],
    ["upstream_unresolvable", 502, "appstrate; error=dns_error"],
    ["upstream_timeout", 504, "appstrate; error=http_response_timeout"],
    ["encryption_key_unavailable", 503, "appstrate; error=proxy_configuration_error"],
  ] as const)("answers %s with %i and one Proxy-Status member", async (code, status, member) => {
    const res = await answer(code);
    expect(res.status).toBe(status);
    expect(res.headers.get("proxy-status")).toBe(member);
    expect(((await res.json()) as { code: string }).code).toBe(code);
  });
});

describe("upstreamFailureDetail", () => {
  it("completes the subject with the failure's phrase", () => {
    expect(upstreamFailureDetail("api.example.com", "upstream_unresolvable")).toBe(
      "api.example.com could not be resolved",
    );
    expect(upstreamFailureDetail("api.example.com", "upstream_unreachable")).toBe(
      "api.example.com could not be reached",
    );
    expect(upstreamFailureDetail("api.example.com", "upstream_timeout")).toBe(
      "api.example.com did not answer in time",
    );
  });
});
