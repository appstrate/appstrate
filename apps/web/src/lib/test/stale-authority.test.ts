// SPDX-License-Identifier: Apache-2.0

/**
 * A refusal that says something about the caller's own standing: a 401 hands
 * over to the auth seam, a 403/404 re-reads the listings the permissions and
 * the space scope are derived from.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const { queryClient } = await import("../query-client.ts");
const { orgKeys } = await import("../query-keys.ts");
const { AUTHORITY_REREAD_INTERVAL_MS, noteStaleAuthority, registerSessionCheck } =
  await import("../stale-authority.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { client } = await import("../../api/client.ts");
const { ApiError } = await import("../../api/errors.ts");

const SPACES_KEY = ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }];
const refusal = (status: number) =>
  new Response(JSON.stringify({ code: "refused", detail: "refused" }), { status });
const request = (path: string) => new Request(`http://localhost${path}`);
const isInvalidated = (key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated ?? false;
const seedListings = () => {
  queryClient.setQueryData(orgKeys.all, []);
  queryClient.setQueryData(SPACES_KEY, { data: [] });
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const SIGNED_IN = { id: "usr_1", email: "olivia@test.com", emailVerified: true };

describe("noteStaleAuthority", () => {
  let sessionRefusals: number;
  let now: Mock<typeof Date.now>;
  // Each test starts a full window after the previous one's last re-read.
  let clock = 1_000_000;

  beforeEach(() => {
    clock += 10 * AUTHORITY_REREAD_INTERVAL_MS;
    now = spyOn(Date, "now").mockImplementation(() => clock);
    queryClient.clear();
    seedListings();
    sessionRefusals = 0;
    authStore.setState({ user: SIGNED_IN, profile: null, loading: false });
    registerSessionCheck({
      hasSession: async () => {
        sessionRefusals += 1;
        return true;
      },
      endSession: async () => {},
    });
  });
  afterEach(() => {
    now.mockRestore();
  });

  it("hands a 401 to the auth seam", () => {
    noteStaleAuthority(request("/api/runs"), refusal(401));

    expect(sessionRefusals).toBe(1);
    expect(isInvalidated(orgKeys.all)).toBe(false);
  });

  it("re-reads the org and space listings on a 403 and on a 404", () => {
    for (const status of [403, 404]) {
      clock += AUTHORITY_REREAD_INTERVAL_MS;
      seedListings();

      noteStaleAuthority(request("/api/runs?limit=15"), refusal(status));

      expect(isInvalidated(orgKeys.all)).toBe(true);
      expect(isInvalidated(SPACES_KEY)).toBe(true);
    }
    expect(sessionRefusals).toBe(0);
  });

  it("re-reads once per window, however many refusals arrive in it", () => {
    const invalidate = spyOn(queryClient, "invalidateQueries");
    try {
      for (let i = 0; i < 20; i++) noteStaleAuthority(request("/api/runs/run_x"), refusal(404));
      clock += AUTHORITY_REREAD_INTERVAL_MS - 1;
      noteStaleAuthority(request("/api/runs/run_x"), refusal(404));

      // One re-read = the two listings and the org detail.
      expect(invalidate).toHaveBeenCalledTimes(3);

      clock += 1;
      noteStaleAuthority(request("/api/runs/run_x"), refusal(404));
      expect(invalidate).toHaveBeenCalledTimes(6);
    } finally {
      invalidate.mockRestore();
    }
  });

  it("does not re-read because one of the re-read requests was refused", () => {
    noteStaleAuthority(request("/api/spaces"), refusal(403));
    noteStaleAuthority(request("/api/orgs"), refusal(403));
    noteStaleAuthority(request("/api/orgs/org_1"), refusal(403));

    expect(isInvalidated(orgKeys.all)).toBe(false);
    expect(isInvalidated(SPACES_KEY)).toBe(false);
  });

  it("re-reads on a refused WRITE under those paths, and refreshes the member list", () => {
    const ORG_DETAIL = ["get", "/api/orgs/{orgId}", { params: { path: { orgId: "org_1" } } }];
    queryClient.setQueryData(ORG_DETAIL, { members: [] });

    noteStaleAuthority(
      new Request("http://localhost/api/orgs/org_1/members", { method: "POST" }),
      refusal(403),
    );

    expect(isInvalidated(orgKeys.all)).toBe(true);
    expect(isInvalidated(ORG_DETAIL)).toBe(true);
  });

  it("leaves other failures alone", () => {
    noteStaleAuthority(request("/api/runs"), refusal(409));
    noteStaleAuthority(request("/api/runs"), refusal(500));

    expect(isInvalidated(orgKeys.all)).toBe(false);
    expect(sessionRefusals).toBe(0);
  });

  it("is wired into the API client: an expired session reaches the auth seam", async () => {
    const error = await client
      .GET("/api/runs", { baseUrl: "http://localhost", fetch: async () => refusal(401) })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(sessionRefusals).toBe(1);
  });
});

describe("registerSessionCheck", () => {
  const signedIn = SIGNED_IN;
  let ended: number;
  let checks: number;

  /** A handler whose session check answers `verdict` — after running `during`, mid-check. */
  const handlerFor = (verdict: boolean | null | Error, during?: () => void) => {
    registerSessionCheck({
      hasSession: async () => {
        checks += 1;
        during?.();
        if (verdict instanceof Error) throw verdict;
        return verdict;
      },
      endSession: async () => {
        ended += 1;
        authStore.setState({ user: null });
      },
    });
    return () => noteStaleAuthority(request("/api/runs"), refusal(401));
  };

  beforeEach(() => {
    ended = 0;
    checks = 0;
    authStore.setState({ user: signedIn, profile: null, loading: false });
    queryClient.clear();
    queryClient.setQueryData<string[]>(["runs"], ["cached"]);
  });

  it("ends the session when Better Auth says there is none", async () => {
    handlerFor(false)();
    await tick();

    expect(ended).toBe(1);
    expect(authStore.getState().user).toBeNull();
  });

  it("checks once for a burst of 401s, including the ones its own check provokes", async () => {
    const handler: () => void = handlerFor(true, () => handler());
    for (let i = 0; i < 5; i++) handler();
    await tick();

    expect(checks).toBe(1);

    // The flight is over: a later 401 is checked again.
    handler();
    await tick();
    expect(checks).toBe(2);
  });

  it("keeps the session and the cache when the session is confirmed", async () => {
    handlerFor(true)();
    await tick();

    expect(ended).toBe(0);
    expect(queryClient.getQueryData<string[]>(["runs"])).toEqual(["cached"]);
  });

  it("revokes nothing when the session could not be checked", async () => {
    for (const verdict of [null, new TypeError("Failed to fetch")]) {
      handlerFor(verdict)();
      await tick();
    }

    expect(ended).toBe(0);
    expect(authStore.getState().user).toEqual(signedIn);
    expect(queryClient.getQueryData<string[]>(["runs"])).toEqual(["cached"]);
  });

  it("does nothing when nobody is signed in", async () => {
    authStore.setState({ user: null });

    handlerFor(false)();
    await tick();

    expect(checks).toBe(0);
    expect(queryClient.getQueryData<string[]>(["runs"])).toEqual(["cached"]);
  });
});
