// SPDX-License-Identifier: Apache-2.0

/**
 * What the global realtime stream asks for, and when it gives up (#1556).
 *
 * A caller without a run read used to ask for `run_update` regardless, get a
 * 403 for the whole stream, and retry it forever — losing its chat and
 * connection updates along the way.
 */

import { describe, it, expect } from "bun:test";
import { globalStreamChannels, isRetryableStreamStatus } from "../use-global-run-sync.ts";

describe("globalStreamChannels", () => {
  it("asks for every channel the hook dispatches on when the caller reads runs and chat is on", () => {
    expect(globalStreamChannels({ readsRuns: true, chat: true })).toBe(
      "run_update,connection_update,chat_session_update",
    );
  });

  it("leaves run_update out for a caller without a run read", () => {
    expect(globalStreamChannels({ readsRuns: false, chat: true })).toBe(
      "connection_update,chat_session_update",
    );
  });

  it("leaves chat_session_update out when the chat feature is off", () => {
    expect(globalStreamChannels({ readsRuns: true, chat: false })).toBe(
      "run_update,connection_update",
    );
    expect(globalStreamChannels({ readsRuns: false, chat: false })).toBe("connection_update");
  });

  it("never asks for the run_log firehose", () => {
    expect(globalStreamChannels({ readsRuns: true, chat: true })).not.toContain("run_log");
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
