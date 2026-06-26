// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  registerStopController,
  unregisterStopController,
  stopStream,
} from "../src/stop-registry.ts";

/**
 * Disconnect ≠ stop: only an explicit stop request aborts generation. The
 * registry maps a stream id to its AbortController so the stop endpoint can
 * reach it.
 */
describe("stop-registry", () => {
  it("aborts the registered controller for a stream id", () => {
    const controller = new AbortController();
    registerStopController("s1", controller);
    expect(controller.signal.aborted).toBe(false);
    expect(stopStream("s1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("returns false for an unknown stream id", () => {
    expect(stopStream("nope")).toBe(false);
  });

  it("does not abort after unregister (turn finalized)", () => {
    const controller = new AbortController();
    registerStopController("s2", controller);
    unregisterStopController("s2");
    expect(stopStream("s2")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  it("only aborts once (stale stop is a no-op)", () => {
    const controller = new AbortController();
    registerStopController("s3", controller);
    expect(stopStream("s3")).toBe(true);
    expect(stopStream("s3")).toBe(false);
  });
});
