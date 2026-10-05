// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  toUnlinkError,
  SessionNotFreshError,
  toLoginError,
  EmailNotVerifiedError,
  hasVerificationLinkError,
} from "../auth-errors";

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

describe("toLoginError", () => {
  it("EMAIL_NOT_VERIFIED → EmailNotVerifiedError instance", () => {
    const err = toLoginError({ code: "EMAIL_NOT_VERIFIED", message: "Email not verified" });
    expect(err).toBeInstanceOf(EmailNotVerifiedError);
    expect(err.message).toBe("Email not verified");
  });

  it("wrong credentials → plain Error carrying the message", () => {
    const err = toLoginError({ code: "INVALID_EMAIL_OR_PASSWORD", message: "nope" });
    expect(err).not.toBeInstanceOf(EmailNotVerifiedError);
    expect(err.message).toBe("nope");
  });
});

describe("hasVerificationLinkError", () => {
  it("recognises the codes Better Auth appends to a verification callback", () => {
    expect(hasVerificationLinkError("?error=INVALID_TOKEN")).toBe(true);
    expect(hasVerificationLinkError("?error=TOKEN_EXPIRED")).toBe(true);
  });

  it("ignores a missing or unrelated error", () => {
    expect(hasVerificationLinkError("")).toBe(false);
    expect(hasVerificationLinkError("?error=access_denied")).toBe(false);
  });
});
