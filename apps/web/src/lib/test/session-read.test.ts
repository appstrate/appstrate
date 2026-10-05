// SPDX-License-Identifier: Apache-2.0

/**
 * Which requests a session read issues (#1678). A visitor on `/login` used to
 * cost a profile request answered 401 and a `POST /api/auth/sign-out`, on every
 * load, for someone who had never signed in.
 */

import { describe, it, expect } from "bun:test";
import {
  readSession,
  rememberSignedIn,
  sessionAfterBoot,
  sessionExpected,
} from "../session-read.ts";

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
    const r = reads(USER, PROFILE);
    expect(await readSession(true, r)).toEqual({ user: USER, profile: PROFILE });
    expect(r.calls).toEqual(["get-session", "profile"]);
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

/** The slice of `Storage` the flag uses, over a map. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  } as Storage;
}

describe("the signed-in hint", () => {
  it("expects no session from a browser that never held one", () => {
    expect(sessionExpected(memoryStorage())).toBe(false);
  });

  it("expects one after a sign-in, and none after the session is torn down", () => {
    const storage = memoryStorage();
    rememberSignedIn(storage, true);
    expect(sessionExpected(storage)).toBe(true);
    rememberSignedIn(storage, false);
    expect(sessionExpected(storage)).toBe(false);
  });
});

describe("sessionAfterBoot", () => {
  it("settles on the boot read when it established a user", async () => {
    let resyncs = 0;
    await sessionAfterBoot(
      Promise.resolve(),
      () => true,
      async () => void resyncs++,
    );
    expect(resyncs).toBe(0);
  });

  it("resyncs, expecting a session, when the boot found none", async () => {
    let resyncs = 0;
    await sessionAfterBoot(
      Promise.resolve(),
      () => false,
      async () => void resyncs++,
    );
    expect(resyncs).toBe(1);
  });

  it("surfaces the resync's refusal to the caller", async () => {
    const refusal = new Error("no session");
    const outcome = sessionAfterBoot(
      Promise.resolve(),
      () => false,
      () => Promise.reject(refusal),
    );
    expect(outcome).rejects.toBe(refusal);
  });
});
