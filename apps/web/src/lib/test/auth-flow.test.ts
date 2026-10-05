// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { EmailNotVerifiedError } from "../auth-errors";
import {
  signedOutDestination,
  loginFailureDestination,
  emailWasChanged,
  EMAIL_CHANGE_CALLBACK_URL,
  emailChangeLanding,
} from "../auth-flow";

describe("signedOutDestination", () => {
  it("is the login page by default", () => {
    expect(signedOutDestination("")).toBe("/login");
    expect(signedOutDestination("?foo=bar")).toBe("/login");
  });

  it("is the verification screen, error kept, after a failed verification link", () => {
    expect(signedOutDestination("?error=INVALID_TOKEN")).toBe("/verify-email?error=INVALID_TOKEN");
    expect(signedOutDestination("?error=TOKEN_EXPIRED")).toBe("/verify-email?error=TOKEN_EXPIRED");
  });
});

describe("loginFailureDestination", () => {
  it("sends an unverified account to the verification screen with its address and destination", () => {
    expect(
      loginFailureDestination(new EmailNotVerifiedError("x"), "a@example.com", "/invite/tok"),
    ).toEqual({
      to: "/verify-email",
      state: { email: "a@example.com", callbackURL: "/invite/tok" },
    });
  });

  it("leaves any other failure to the form", () => {
    expect(
      loginFailureDestination(new Error("Invalid email or password"), "a@example.com", "/"),
    ).toBe(null);
  });
});

describe("emailWasChanged", () => {
  it("is true when the session carries the requested address (case and spaces aside)", () => {
    expect(emailWasChanged(" New@Example.com ", "new@example.com")).toBe(true);
  });

  it("is false when the session still carries the old address — the requested one was taken", () => {
    expect(emailWasChanged("taken@example.com", "me@example.com")).toBe(false);
    expect(emailWasChanged("taken@example.com", undefined)).toBe(false);
  });
});

describe("emailChangeLanding", () => {
  const search = new URL(EMAIL_CHANGE_CALLBACK_URL, "http://x").search;

  it("is null on an ordinary visit", () => {
    expect(emailChangeLanding("")).toBe(null);
    expect(emailChangeLanding("?error=INVALID_TOKEN")).toBe(null);
  });

  it("reports an accepted link", () => {
    expect(emailChangeLanding(search)).toBe("accepted");
  });

  it("reports a link that could not be honoured", () => {
    expect(emailChangeLanding(`${search}&error=TOKEN_EXPIRED`)).toBe("failed");
  });

  it("carries no address", () => {
    expect(EMAIL_CHANGE_CALLBACK_URL).not.toContain("@");
  });
});
