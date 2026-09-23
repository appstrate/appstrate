// SPDX-License-Identifier: Apache-2.0

/**
 * A local integration server whose credential never crosses the MITM (SSH,
 * env-delivered keys) reports a rejected credential through a `_meta` signal
 * on its tool error. The sidecar must turn exactly that signal — and nothing
 * else — into a report, and hand the agent the result unchanged.
 */

import { describe, it, expect } from "bun:test";
import type { AppstrateMcpClient, CallToolResult } from "@appstrate/mcp-transport";
import {
  CREDENTIAL_META_KEY,
  isCredentialRejectedResult,
  postIntegrationCredentialsRefresh,
} from "../integration-credentials-source.ts";
import { reportCredentialRejections } from "../integrations-boot.ts";

const rejected: CallToolResult = {
  isError: true,
  content: [{ type: "text", text: "denied" }],
  _meta: { [CREDENTIAL_META_KEY]: { status: "rejected", reason: "publickey_rejected" } },
};

function clientReturning(result: CallToolResult): AppstrateMcpClient {
  return { callTool: async () => result } as unknown as AppstrateMcpClient;
}

describe("credential rejection signal", () => {
  it("recognises only an isError result carrying status: rejected", () => {
    expect(isCredentialRejectedResult(rejected)).toBe(true);
    expect(isCredentialRejectedResult({ ...rejected, isError: false })).toBe(false);
    expect(isCredentialRejectedResult({ isError: true })).toBe(false);
    expect(
      isCredentialRejectedResult({
        isError: true,
        _meta: { [CREDENTIAL_META_KEY]: { status: "ok" } },
      }),
    ).toBe(false);
  });

  it("reports a rejection once per rejected call and passes every result through", async () => {
    let reports = 0;
    const ok: CallToolResult = { content: [{ type: "text", text: "fine" }] };
    const bad = reportCredentialRejections(clientReturning(rejected), () => reports++);
    const good = reportCredentialRejections(clientReturning(ok), () => reports++);

    expect(await bad.callTool({ name: "ssh_exec", arguments: {} })).toBe(rejected);
    expect(await good.callTool({ name: "ssh_exec", arguments: {} })).toBe(ok);
    expect(reports).toBe(1);
  });

  it("reports to the platform's forced-refresh endpoint with the run token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 502 });
    }) as unknown as typeof fetch;
    await postIntegrationCredentialsRefresh("@appstrate/ssh", {
      platformApiUrl: "http://platform",
      runToken: "rt",
      fetchFn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://platform/internal/integration-credentials/@appstrate/ssh/refresh",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.headers).toEqual({ Authorization: "Bearer rt" });
  });
});
