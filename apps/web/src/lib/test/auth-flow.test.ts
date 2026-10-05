// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { EmailNotVerifiedError } from "../auth-errors";
import {
  signedOutDestination,
  loginFailureDestination,
  emailWasChanged,
  emailChangeCallbackURL,
  emailChangeLanding,
  followsAuthRedirect,
  afterGate,
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
  const search = emailChangeCallbackURL("New+tag@Example.com").replace("/preferences", "");

  it("is null on an ordinary visit", () => {
    expect(emailChangeLanding("", "me@example.com")).toBe(null);
    expect(emailChangeLanding("?error=INVALID_TOKEN", "me@example.com")).toBe(null);
  });

  it("reports the approval while the session still has the old address", () => {
    expect(emailChangeLanding(search, "me@example.com")).toEqual({
      kind: "approved",
      email: "new+tag@example.com",
    });
  });

  it("reports the change once the session has the new address", () => {
    expect(emailChangeLanding(search, "new+tag@example.com")).toEqual({ kind: "changed" });
  });

  it("reports a link that could not be honoured", () => {
    expect(emailChangeLanding(`${search}&error=TOKEN_EXPIRED`, "me@example.com")).toEqual({
      kind: "failed",
    });
  });
});

describe("followsAuthRedirect", () => {
  const redirect = { redirect: true, url: "https://accounts.example.com/o/oauth2" };

  it("follows a social sign-in to its provider", () => {
    expect(followsAuthRedirect("/api/auth/sign-in/social", redirect)).toBe(true);
  });

  it("never navigates after an email sign-in, callbackURL or not", () => {
    expect(
      followsAuthRedirect("/api/auth/sign-in/email", { redirect: true, url: "/invite/tok" }),
    ).toBe(false);
  });

  it("follows a path on this origin, and refuses a non-http scheme", () => {
    expect(
      followsAuthRedirect("/api/auth/link-social", { redirect: true, url: "/preferences" }),
    ).toBe(true);
    expect(
      followsAuthRedirect("/api/auth/sign-in/social", {
        redirect: true,
        url: "javascript:alert(1)",
      }),
    ).toBe(false);
  });

  it("ignores a response that asks for nothing", () => {
    expect(followsAuthRedirect("/api/auth/sign-in/social", { redirect: false, url: "/x" })).toBe(
      false,
    );
    expect(followsAuthRedirect("/api/auth/sign-in/social", { redirect: true })).toBe(false);
    expect(followsAuthRedirect("/api/auth/get-session", null)).toBe(false);
  });
});

describe("afterGate", () => {
  it("runs the action only once the gate has settled, with its arguments and result", async () => {
    const events: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = () => {
        events.push("gate settled");
        resolve();
      };
    });
    const signIn = afterGate(
      () => gate,
      async (email: string) => {
        events.push(`sign-in ${email}`);
        return "ok";
      },
    );

    const pending = signIn("a@example.com");
    await Promise.resolve();
    expect(events).toEqual([]);

    openGate();
    expect(await pending).toBe("ok");
    expect(events).toEqual(["gate settled", "sign-in a@example.com"]);
  });
});
