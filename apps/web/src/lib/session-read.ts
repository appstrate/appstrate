// SPDX-License-Identifier: Apache-2.0

import { LOCAL_STORAGE_KEYS, createLocalStore } from "@appstrate/ui/local-storage";

const signedIn = createLocalStore(LOCAL_STORAGE_KEYS.signedIn, {
  parse: (raw) => raw !== null,
  serialize: (value) => (value ? "1" : null),
});

/** Whether the next boot should expect a session: the cookie itself is httpOnly. */
export function sessionExpected(): boolean {
  return signedIn.read();
}

/** Set on a session and before any sign-in attempt. A hint: a stale value corrects itself in one boot. */
export function rememberSignedIn(value: boolean): void {
  signedIn.write(value);
}

export interface SessionReads<User, Profile> {
  getSession: () => Promise<User | null>;
  getProfile: () => Promise<Profile | null>;
  dropCookies: () => Promise<void>;
}

/**
 * Expected: session and profile together, and a cookie that yields no session
 * is dropped (`get-session` does not clear it). Otherwise: the session alone.
 */
export async function readSession<User, Profile>(
  expected: boolean,
  reads: SessionReads<User, Profile>,
): Promise<{ user: User; profile: Profile } | null> {
  const [user, eagerProfile] = await Promise.all([
    reads.getSession(),
    expected ? reads.getProfile() : null,
  ]);
  if (!user) {
    if (expected) await reads.dropCookies();
    return null;
  }
  const profile = expected ? eagerProfile : await reads.getProfile();
  if (!profile) {
    await reads.dropCookies();
    return null;
  }
  return { user, profile };
}
