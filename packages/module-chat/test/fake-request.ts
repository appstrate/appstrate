// SPDX-License-Identifier: Apache-2.0

/** The host's request seam, faked: `ChatRequest` (a non-2xx answer thrown with its `status`/`code`) and the transport. */

import type { ChatRequest, ChatTransport } from "../src/ui/runtime-context.ts";

class FakeProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API Error: ${status}`);
  }
}

export interface FakeRequest extends ChatRequest {
  calls: { path: string; init?: RequestInit }[];
}

/** A request function answering every call with `answer(path, init)`. */
export function requestAnswering(
  answer: (path: string, init?: RequestInit) => Response = () => Response.json({}),
): FakeRequest {
  const calls: FakeRequest["calls"] = [];
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    const response = answer(path, init);
    if (!response.ok) throw new FakeProblem(response.status, "problem");
    return response;
  };
  return Object.assign(request, { calls });
}

/** The transport a static render is given: headers as the host scopes them, requests never answered. */
export function transportOf(getHeaders: () => Record<string, string>): ChatTransport {
  return { getHeaders, request: () => Promise.reject(new Error("no request in a static render")) };
}
