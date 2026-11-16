// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { chatTransport } from "./chat-transport";

const realFetch = globalThis.fetch;
const RealRequest = globalThis.Request;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.Request = RealRequest;
});

/** A browser resolves `/api/…` against the page; the test runner has no page. */
class PageRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(
      typeof input === "string" && input.startsWith("/") ? `http://localhost${input}` : input,
      init,
    );
  }
}

const HEADERS = { "X-Org-Id": "org_1", "X-Space-Id": "spc_a", "X-Chat-Locale": "fr" };

/** The headers the network would see for one `request` through the transport. */
async function sent(path: string) {
  let seen: Request | undefined;
  globalThis.Request = PageRequest;
  globalThis.fetch = (async (input: Request) => {
    seen = input;
    return Response.json({});
  }) as unknown as typeof fetch;
  await chatTransport(() => HEADERS, "org_1", "spc_a").request(path);
  return seen!.headers;
}

describe("chatTransport", () => {
  it("names the organization and the space filter it was built for", () => {
    const transport = chatTransport(() => HEADERS, "org_1", null);
    expect(transport.orgId).toBe("org_1");
    expect(transport.spaceId).toBeNull();
  });

  it("sends the organization's chat routes without X-Space-Id", async () => {
    const headers = await sent("/api/orgs/org_1/chat/sessions");
    expect(headers.get("X-Space-Id")).toBeNull();
    expect(headers.get("X-Org-Id")).toBe("org_1");
    expect(headers.get("X-Chat-Locale")).toBe("fr");
  });

  it("keeps the working space on the calls that are not the organization's", async () => {
    expect((await sent("/api/uploads")).get("X-Space-Id")).toBe("spc_a");
  });
});
