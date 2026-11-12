// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  followRunAndWaitLogs,
  RUN_AND_WAIT_LOG_MESSAGE_MAX_CHARS,
  type RunAndWaitLogLine,
} from "../src/run-and-wait-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers each log read with the next response, recording the requested URLs. */
function scriptedFetch(answers: Array<Response | Error>): {
  fetch: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(input.toString());
    const next = answers.shift() ?? new Response("gone", { status: 500 });
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, urls };
}

async function collect(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<RunAndWaitLogLine[][]> {
  const reads: RunAndWaitLogLine[][] = [];
  for await (const lines of followRunAndWaitLogs("run 1", {
    origin: "https://test.local",
    headers: { authorization: "Bearer tok" },
    fetch: fetchImpl,
    pollMs: 1,
    ...(signal ? { signal } : {}),
  })) {
    reads.push(lines);
  }
  return reads;
}

const page = (data: unknown[]) => jsonResponse({ object: "list", data, hasMore: false });

describe("followRunAndWaitLogs", () => {
  it("reads info-and-above lines after the last row seen, one yield per read with lines", async () => {
    const { fetch, urls } = scriptedFetch([
      page([
        { id: 3, level: "info", message: "Fetching inbox" },
        { id: 4, level: "warn", message: null },
      ]),
      page([]),
      page([{ id: 9, level: "error", message: "Quota exceeded" }]),
      new Response("forbidden", { status: 403 }),
    ]);

    expect(await collect(fetch)).toEqual([
      [{ id: 3, level: "info", message: "Fetching inbox" }],
      [{ id: 9, level: "error", message: "Quota exceeded" }],
    ]);
    // The cursor moves past a row without a message too.
    expect(urls).toEqual([
      "https://test.local/api/runs/run%201/logs?level=info",
      "https://test.local/api/runs/run%201/logs?level=info&since=4",
      "https://test.local/api/runs/run%201/logs?level=info&since=4",
      "https://test.local/api/runs/run%201/logs?level=info&since=9",
    ]);
  });

  it("puts a message on one line and cuts it at the maximum length", async () => {
    const long = "x".repeat(RUN_AND_WAIT_LOG_MESSAGE_MAX_CHARS + 50);
    const { fetch } = scriptedFetch([
      page([
        { id: 1, level: "info", message: "  step 1\n\tdone  " },
        { id: 2, level: "info", message: long },
        { id: 3, level: "info", message: " \n " },
      ]),
    ]);

    const [lines] = await collect(fetch);
    expect(lines?.map((l) => l.message)).toEqual([
      "step 1 done",
      `${"x".repeat(RUN_AND_WAIT_LOG_MESSAGE_MAX_CHARS - 1)}…`,
    ]);
  });

  it("ends without throwing on a network error or a malformed body", async () => {
    expect(await collect(scriptedFetch([new Error("ECONNRESET")]).fetch)).toEqual([]);
    expect(await collect(scriptedFetch([jsonResponse({ nope: true })]).fetch)).toEqual([]);
  });

  it("ends once the caller's signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, urls } = scriptedFetch([page([{ id: 1, level: "info", message: "x" }])]);

    expect(await collect(fetch, controller.signal)).toEqual([]);
    expect(urls).toEqual([]);
  });
});
