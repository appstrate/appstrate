// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "bun:test";
import { ApiError } from "../../api/errors";
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

/** The request the network would see for one `request` through the transport, answered by `reply`. */
async function sent(init?: RequestInit, reply: () => Response = () => Response.json({})) {
  let seen: Request | undefined;
  globalThis.Request = PageRequest;
  globalThis.fetch = (async (input: Request) => {
    seen = input;
    return reply();
  }) as unknown as typeof fetch;
  const outcome = await chatTransport(() => HEADERS, "org_1", "spc_a")
    .request("/api/orgs/org_1/chat/sessions/chs_1", init)
    .catch((error: unknown) => error);
  return { headers: seen!.headers, outcome };
}

describe("chatTransport", () => {
  it("sends the built headers, a call's own headers overriding them", async () => {
    const { headers } = await sent({ headers: { "X-Chat-Locale": "en", "X-Model-Id": "m_1" } });
    expect(headers.get("X-Org-Id")).toBe("org_1");
    expect(headers.get("X-Space-Id")).toBe("spc_a");
    expect(headers.get("X-Chat-Locale")).toBe("en");
    expect(headers.get("X-Model-Id")).toBe("m_1");
  });

  it("throws a refusal as an ApiError carrying the server's problem code", async () => {
    const { outcome } = await sent({ method: "PATCH" }, () =>
      Response.json(
        { code: "chat_turn_in_flight", detail: "busy", status: 409 },
        { status: 409, headers: { "Content-Type": "application/problem+json" } },
      ),
    );
    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ code: "chat_turn_in_flight", status: 409 });
  });
});
