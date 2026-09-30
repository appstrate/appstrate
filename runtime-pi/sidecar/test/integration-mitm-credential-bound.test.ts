// SPDX-License-Identifier: Apache-2.0

/**
 * The MITM listener injects a credential only under an allowlist naming its hosts — the rule
 * the three api_call paths apply (`credentialUrlPolicy`), re-checked at run time for manifests
 * published before the write-path check. `handleInnerRequest` is driven directly.
 */

import { describe, it, expect } from "bun:test";
import {
  handleInnerRequest,
  type MitmCredentialSource,
  type MitmListenerEvent,
} from "../integration-mitm-listener.ts";

const allowAll = { allowsUrl: () => true };

function source(authorizedUris: string[]): MitmCredentialSource {
  return {
    current: () => ({
      auths: [{ authKey: "api", authType: "api_key", fields: { api_key: "k" }, authorizedUris }],
    }),
    deliveryPlans: () => ({
      api: { headerName: "X-Api-Key", headerPrefix: "", value: "k", allowServerOverride: false },
    }),
  };
}

async function send(authorizedUris: string[]) {
  const sent: Headers[] = [];
  const events: MitmListenerEvent[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response("ok");
  }) as unknown as typeof fetch;
  const res = await handleInnerRequest(
    new Request("https://127.0.0.1/v1/things"),
    "attacker.example",
    source(authorizedUris),
    fetchFn,
    1024,
    (e) => events.push(e),
    allowAll,
  );
  return { res, sent, events };
}

describe("MITM listener — injected credential needs a host-bounded allowlist", () => {
  it("refuses to inject under a host-unbounded pattern", async () => {
    const { res, sent, events } = await send(["https://**"]);
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect(events).toContainEqual({
      kind: "request-refused",
      url: "https://attacker.example/v1/things",
      reason: "credential not host-bounded",
    });
  });

  it("refuses the connect re-login replay once it would inject", async () => {
    let session = ""; // not acquired yet: the first attempt injects nothing
    const src: MitmCredentialSource = {
      current: () => ({
        auths: [{ authKey: "s", authType: "custom", fields: {}, authorizedUris: ["https://**"] }],
      }),
      deliveryPlans: () => ({
        s: {
          headerName: "Cookie",
          headerPrefix: "sid=",
          value: session,
          allowServerOverride: false,
        },
      }),
      shouldReauth: (_key, status) => status === 401,
      hasReloginHandler: () => true,
      refreshOnUnauthorized: async () => {
        session = "fresh";
        return true;
      },
    };
    const sent: Headers[] = [];
    const events: MitmListenerEvent[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("no", { status: 401 });
    }) as unknown as typeof fetch;
    const res = await handleInnerRequest(
      new Request("https://127.0.0.1/v1/things"),
      "attacker.example",
      src,
      fetchFn,
      1024,
      (e) => events.push(e),
      allowAll,
    );
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("cookie")).toBeNull();
    expect(events).toContainEqual({
      kind: "request-refused",
      url: "https://attacker.example/v1/things",
      reason: "credential not host-bounded",
    });
  });

  it("injects under an allowlist naming the host", async () => {
    const { res, sent } = await send(["https://attacker.example/**"]);
    expect(res.status).toBe(200);
    expect(sent[0]!.get("x-api-key")).toBe("k");
  });
});
