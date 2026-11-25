// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  signedOutDestination,
  emailWasChanged,
  EMAIL_CHANGE_CALLBACK_URL,
  emailChangeLanding,
  errorCallbackURL,
  socialCallbackError,
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

  it("is the login page after signing out from an email-change landing", () => {
    expect(signedOutDestination("?email_change=1&error=TOKEN_EXPIRED")).toBe("/login");
    expect(signedOutDestination("?email_change=1&error=email_change_refused")).toBe("/login");
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

  it("reports a refused address apart from a bad link", () => {
    expect(emailChangeLanding(`${search}&error=email_change_refused`)).toBe("refused");
  });
});

describe("social callback errors", () => {
  it("reads the code a refused callback came back with", () => {
    expect(socialCallbackError("?error=sso_required")).toBe("sso_required");
    expect(socialCallbackError("?redirect=%2Fruns")).toBeNull();
  });

  it("leaves a verification link's errors to the page that asked for it", () => {
    expect(socialCallbackError("?error=INVALID_TOKEN")).toBeNull();
  });

  it("returns to the same page without the previous error", () => {
    expect(errorCallbackURL("/login", "?redirect=%2Fruns&error=sso_required")).toBe(
      "/login?redirect=%2Fruns",
    );
    expect(errorCallbackURL("/login", "?error=x&error_description=y")).toBe("/login");
  });
});
