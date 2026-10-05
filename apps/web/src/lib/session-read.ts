// SPDX-License-Identifier: Apache-2.0

/**
 * The session read behind `use-auth.ts`, as pure functions of the server calls
 * and the storage they touch, so the request plan of each case is pinned by a
 * test.
 */

const SIGNED_IN_KEY = "appstrate_signed_in";

/**
 * Whether this browser last saw the app signed in — the `expected` of
 * {@link readSession}. A hint, never an authority: a stale `true` costs one
 * boot two requests answered 401 and a sign-out, a stale `false` costs a
 * signed-in user one sequential round trip, and both correct themselves on
 * that same boot.
 */
export function sessionExpected(storage: Storage): boolean {
  return storage.getItem(SIGNED_IN_KEY) !== null;
}

export function rememberSignedIn(storage: Storage, signedIn: boolean): void {
  if (signedIn) storage.setItem(SIGNED_IN_KEY, "1");
  else storage.removeItem(SIGNED_IN_KEY);
}

export interface SessionReads<User, Profile> {
  getSession: () => Promise<User | null>;
  getProfile: () => Promise<Profile | null>;
  /** Has the server expire every auth cookie the browser still sends. */
  dropCookies: () => Promise<void>;
}

/**
 * `expected` says whether this browser last saw the app signed in — the session
 * cookie is httpOnly, so that is all the page can know before asking.
 *
 * Expected: the session and the profile authenticate on the same cookie, so
 * they are read together rather than one behind the other. A cookie that yields
 * no session (secret rotated, session row gone, domain or partition changed) is
 * dropped: Better Auth's `get-session` answers null WITHOUT clearing it, so it
 * would keep arriving, shadow the next sign-in and bounce the user between the
 * login page and the OIDC callback with nothing to show for it.
 *
 * Not expected (a visitor on a public page): the session read and nothing else.
 * No profile request bound to answer 401, and no sign-out for someone who never
 * signed in.
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
    // A session whose profile cannot be loaded is not usable either.
    await reads.dropCookies();
    return null;
  }
  return { user, profile };
}

/**
 * Assert the session a full-page redirect was meant to leave behind. The
 * cookie was set before the document loaded, so its boot read IS the read of
 * that session and a second one would only repeat it. When the boot found
 * none it may not have been expecting one, so the resync that does — and that
 * drops the cookie that failed — runs then, and only then.
 */
export async function sessionAfterBoot(
  boot: Promise<void>,
  hasUser: () => boolean,
  resync: () => Promise<void>,
): Promise<void> {
  await boot;
  if (!hasUser()) await resync();
}
