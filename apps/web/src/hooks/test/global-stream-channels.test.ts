// SPDX-License-Identifier: Apache-2.0

/**
 * What the global realtime stream asks for, and when it gives up (#1556).
 *
 * A caller without a run read used to ask for `run_update` regardless, get a
 * 403 for the whole stream, and retry it forever — losing its chat and
 * connection updates along the way.
 */

import { describe, it, expect } from "bun:test";
import {
  globalStreamChannels,
  isRetryableStreamStatus,
  reconnectUntilRefused,
} from "../use-global-run-sync.ts";

describe("globalStreamChannels", () => {
  it("asks for every channel the hook dispatches on when the caller reads runs and chat", () => {
    expect(globalStreamChannels({ readsRuns: true, readsChat: true })).toBe(
      "run_update,connection_update,chat_session_update",
    );
  });

  it("leaves run_update out for a caller without a run read", () => {
    expect(globalStreamChannels({ readsRuns: false, readsChat: true })).toBe(
      "connection_update,chat_session_update",
    );
  });

  it("leaves chat_session_update out for a caller who cannot open chat", () => {
    expect(globalStreamChannels({ readsRuns: true, readsChat: false })).toBe(
      "run_update,connection_update",
    );
    expect(globalStreamChannels({ readsRuns: false, readsChat: false })).toBe("connection_update");
  });

  it("never asks for the run_log firehose", () => {
    expect(globalStreamChannels({ readsRuns: true, readsChat: true })).not.toContain("run_log");
  });
});

describe("isRetryableStreamStatus", () => {
  it("gives up on a refusal of the request itself", () => {
    for (const status of [400, 401, 403, 404]) expect(isRetryableStreamStatus(status)).toBe(false);
  });

  it("retries a rate limit and a server-side failure", () => {
    for (const status of [429, 500, 502, 503]) expect(isRetryableStreamStatus(status)).toBe(true);
  });
});

describe("reconnectUntilRefused", () => {
  it("stops at the first refusal, without backing off", async () => {
    let connects = 0;
    let backoffs = 0;
    await reconnectUntilRefused(
      async () => (++connects, "refused"),
      new AbortController().signal,
      async () => void backoffs++,
    );
    expect([connects, backoffs]).toEqual([1, 0]);
  });

  it("backs off and retries an ended stream or a failed attempt until aborted", async () => {
    const controller = new AbortController();
    let connects = 0;
    await reconnectUntilRefused(
      async () => {
        if (++connects === 3) controller.abort();
        if (connects === 1) throw new Error("503");
        return "ended";
      },
      controller.signal,
      async () => {},
    );
    expect(connects).toBe(3);
  });
});
