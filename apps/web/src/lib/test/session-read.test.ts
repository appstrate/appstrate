// SPDX-License-Identifier: Apache-2.0

/**
 * Which requests a session read issues. A visitor on `/login` used to
 * cost a profile request answered 401 and a `POST /api/auth/sign-out`, on every
 * load, for someone who had never signed in.
 */

import { describe, it, expect } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { readSession, rememberSignedIn, sessionExpected } from "../session-read.ts";

const USER = { id: "usr_1" };
const PROFILE = { id: "usr_1", language: "fr" };

function reads(session: typeof USER | null, profile: typeof PROFILE | null) {
  const calls: string[] = [];
  return {
    calls,
    getSession: async () => {
      calls.push("get-session");
      return session;
    },
    getProfile: async () => {
      calls.push("profile");
      return profile;
    },
    dropCookies: async () => {
      calls.push("sign-out");
    },
  };
}

describe("readSession", () => {
  it("asks a visitor's browser for the session and nothing else", async () => {
    const r = reads(null, null);
    expect(await readSession(false, r)).toBeNull();
    expect(r.calls).toEqual(["get-session"]);
  });

  it("reads the profile once the unexpected session turns out to exist", async () => {
    const r = reads(USER, PROFILE);
    expect(await readSession(false, r)).toEqual({ user: USER, profile: PROFILE });
    expect(r.calls).toEqual(["get-session", "profile"]);
  });

  it("reads an expected session and its profile together", async () => {
    // The session answers only once the profile has been asked for: a
    // sequential read would never get there.
    let profileAsked: () => void = () => {};
    const asked = new Promise<void>((resolve) => (profileAsked = resolve));
    const session = await readSession(true, {
      getSession: () => asked.then(() => USER),
      getProfile: async () => {
        profileAsked();
        return PROFILE;
      },
      dropCookies: async () => {},
    });
    expect(session).toEqual({ user: USER, profile: PROFILE });
  });

  it("drops the cookie that failed to yield an expected session", async () => {
    const r = reads(null, null);
    expect(await readSession(true, r)).toBeNull();
    expect(r.calls).toEqual(["get-session", "profile", "sign-out"]);
  });

  it("drops a session whose profile cannot be loaded, expected or not", async () => {
    for (const expected of [true, false]) {
      const r = reads(USER, null);
      expect(await readSession(expected, r)).toBeNull();
      expect(r.calls).toEqual(["get-session", "profile", "sign-out"]);
    }
  });
});

describe("the signed-in hint", () => {
  it("expects no session from a browser that never held one", () => {
    expect(sessionExpected(installFakeStorage())).toBe(false);
  });

  it("expects one after a sign-in, and none after the session is torn down", () => {
    const storage = installFakeStorage();
    rememberSignedIn(storage, true);
    expect(sessionExpected(storage)).toBe(true);
    rememberSignedIn(storage, false);
    expect(sessionExpected(storage)).toBe(false);
  });
});
