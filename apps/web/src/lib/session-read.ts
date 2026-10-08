// SPDX-License-Identifier: Apache-2.0

const SIGNED_IN_KEY = "appstrate_signed_in";

/** Whether the next boot should expect a session: the cookie itself is httpOnly. */
export function sessionExpected(storage: Storage): boolean {
  return storage.getItem(SIGNED_IN_KEY) !== null;
}

/**
 * Set on a session and just before any sign-in attempt, so the next boot drops
 * a cookie that yields none. A hint: a stale value corrects itself in one boot.
 */
export function rememberSignedIn(storage: Storage, signedIn: boolean): void {
  if (signedIn) storage.setItem(SIGNED_IN_KEY, "1");
  else storage.removeItem(SIGNED_IN_KEY);
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
