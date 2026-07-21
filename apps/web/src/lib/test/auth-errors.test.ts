// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { toUnlinkError, SessionNotFreshError } from "../auth-errors";

describe("toUnlinkError", () => {
  it("SESSION_NOT_FRESH → SessionNotFreshError instance", () => {
    const err = toUnlinkError({ code: "SESSION_NOT_FRESH", message: "too old" });
    expect(err).toBeInstanceOf(SessionNotFreshError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("too old");
  });

  it("other code → plain Error (not SessionNotFreshError)", () => {
    const err = toUnlinkError({ code: "SOMETHING_ELSE", message: "nope" });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SessionNotFreshError);
    expect(err.message).toBe("nope");
  });

  it("no code → plain Error", () => {
    const err = toUnlinkError({ message: "boom" });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SessionNotFreshError);
    expect(err.message).toBe("boom");
  });

  it("null code preserves message on plain Error", () => {
    const err = toUnlinkError({ code: null, message: "bad" });
    expect(err).not.toBeInstanceOf(SessionNotFreshError);
    expect(err.message).toBe("bad");
  });

  it("null message falls back to empty string", () => {
    const err = toUnlinkError({ code: "SESSION_NOT_FRESH", message: null });
    expect(err).toBeInstanceOf(SessionNotFreshError);
    expect(err.message).toBe("");
  });

  it("undefined message falls back to empty string", () => {
    const err = toUnlinkError({ code: "OTHER" });
    expect(err.message).toBe("");
  });
});
