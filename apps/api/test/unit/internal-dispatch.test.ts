// SPDX-License-Identifier: Apache-2.0

/**
 * Internal self-dispatch marker (`internal-dispatch.ts`). The marker exempts an
 * in-process re-entry from outbound resource-audience confinement, so its
 * unforgeability is security-relevant.
 */

import { describe, it, expect } from "bun:test";
import { internalDispatchHeader, isInternalDispatch } from "../../src/lib/internal-dispatch.ts";

describe("internal-dispatch marker", () => {
  it("recognises a request stamped with the current process marker", () => {
    const [name, value] = internalDispatchHeader();
    const h = new Headers({ [name]: value });
    expect(isInternalDispatch(h)).toBe(true);
  });

  it("rejects a request with no marker", () => {
    expect(isInternalDispatch(new Headers())).toBe(false);
  });

  it("rejects a forged marker value", () => {
    const [name] = internalDispatchHeader();
    expect(isInternalDispatch(new Headers({ [name]: "guessed" }))).toBe(false);
  });

  it("rejects an empty marker value", () => {
    const [name] = internalDispatchHeader();
    expect(isInternalDispatch(new Headers({ [name]: "" }))).toBe(false);
  });

  it("rejects a value of the right length but wrong content", () => {
    const [name, value] = internalDispatchHeader();
    // Same length (so the constant-time compare runs), different bytes.
    const wrong = "0".repeat(value.length);
    expect(wrong.length).toBe(value.length);
    expect(isInternalDispatch(new Headers({ [name]: wrong }))).toBe(false);
  });

  it("uses a stable per-process value", () => {
    expect(internalDispatchHeader()[1]).toBe(internalDispatchHeader()[1]);
  });
});
