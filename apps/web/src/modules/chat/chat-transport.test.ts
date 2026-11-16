// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import {
  chatScopeId,
  chatTransport,
  conversationOfPath,
  conversationOpening,
  scopeChangeLeavesConversation,
} from "./chat-transport";

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

/** The headers the network would see for one `request` through `transport`. */
async function sent(scope: Parameters<typeof chatTransport>[1], path: string) {
  let seen: Request | undefined;
  globalThis.Request = PageRequest;
  globalThis.fetch = (async (input: Request) => {
    seen = input;
    return Response.json({});
  }) as unknown as typeof fetch;
  await chatTransport(() => HEADERS, scope).request(path);
  return seen!.headers;
}

describe("chatTransport", () => {
  const org = { kind: "organization", orgId: "org_1" } as const;

  it("sends the organization's chat routes without X-Space-Id", async () => {
    const headers = await sent(org, "/api/orgs/org_1/chat/sessions");
    expect(headers.get("X-Space-Id")).toBeNull();
    expect(headers.get("X-Org-Id")).toBe("org_1");
    expect(headers.get("X-Chat-Locale")).toBe("fr");
  });

  it("keeps the working space on the calls that are not the organization's", async () => {
    expect((await sent(org, "/api/uploads")).get("X-Space-Id")).toBe("spc_a");
    expect((await sent({ kind: "space" }, "/api/chat/sessions")).get("X-Space-Id")).toBe("spc_a");
  });
});

describe("conversationOpening", () => {
  const org = { kind: "organization", orgId: "org_1" } as const;

  it("opens a space session of the overview in its own space", () => {
    expect(conversationOpening(org, "chs_1", "spc_b")).toEqual({
      kind: "in-space",
      spaceId: "spc_b",
    });
  });

  it("opens an organization session, a new conversation and any pick in a space in place", () => {
    expect(conversationOpening(org, "chs_2", null)).toEqual({ kind: "here" });
    expect(conversationOpening(org, null, null)).toEqual({ kind: "here" });
    expect(conversationOpening({ kind: "space" }, "chs_1", "spc_b")).toEqual({ kind: "here" });
  });
});

describe("chatScopeId", () => {
  it("tells the organization from each space", () => {
    expect(chatScopeId({ kind: "organization", orgId: "org_1" }, "spc_a")).toBe("org:org_1");
    expect(chatScopeId({ kind: "space" }, "spc_a")).toBe("spc_a");
    expect(chatScopeId({ kind: "space" }, null)).toBeNull();
  });
});

describe("scopeChangeLeavesConversation", () => {
  const open = { scopeId: "spc_a", conversationId: "chs_1" };

  it("drops an open conversation when the scope changes under it", () => {
    for (const scopeId of ["org:org_1", "spc_b"]) {
      expect(scopeChangeLeavesConversation(open, { ...open, scopeId }, "chs_1")).toBe(true);
    }
  });

  it("drops a conversation not yet saved too: its turn route is fixed when it is created", () => {
    const draft = { scopeId: "spc_a", conversationId: null };
    expect(scopeChangeLeavesConversation(draft, { ...draft, scopeId: "org:org_1" }, null)).toBe(
      true,
    );
  });

  it("leaves a pick in the list alone: it changes the scope and the conversation together", () => {
    // The router still renders the old conversation; the address already names the picked one.
    expect(
      scopeChangeLeavesConversation(open, { scopeId: "spc_b", conversationId: "chs_1" }, "chs_9"),
    ).toBe(false);
    expect(
      scopeChangeLeavesConversation(open, { scopeId: "spc_b", conversationId: "chs_9" }, "chs_9"),
    ).toBe(false);
  });

  it("does nothing while the scope holds, or before the first place is known", () => {
    expect(scopeChangeLeavesConversation(open, open, "chs_1")).toBe(false);
    expect(scopeChangeLeavesConversation(null, open, "chs_1")).toBe(false);
  });
});

describe("conversationOfPath", () => {
  it("reads the conversation an address names", () => {
    expect(conversationOfPath("/chat/chs_1")).toBe("chs_1");
    expect(conversationOfPath("/chat/chs_1/")).toBe("chs_1");
    expect(conversationOfPath("/chat")).toBeNull();
    expect(conversationOfPath("/runs")).toBeNull();
  });
});
