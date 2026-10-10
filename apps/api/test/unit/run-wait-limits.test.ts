// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { MAX_WAIT_SECONDS } from "../../src/lib/run-wait-limits.ts";

describe("run-wait limits", () => {
  it('keeps MAX_WAIT_SECONDS at 55 (a change moves the OpenAPI text and the AGENTS.md "Operational Notes & Known Limitations" section)', () => {
    expect(MAX_WAIT_SECONDS).toBe(55);
  });
});
