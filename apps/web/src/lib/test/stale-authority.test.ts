// SPDX-License-Identifier: Apache-2.0

/**
 * A refusal that says something about the caller's own standing: a 401 hands
 * over to the auth seam, a 403/404 re-reads the listings the permissions and
 * the space scope are derived from.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const { queryClient } = await import("../query-client.ts");
const { orgKeys } = await import("../query-keys.ts");
const { noteStaleAuthority, setSessionRefusedHandler } = await import("../stale-authority.ts");
const { client } = await import("../../api/client.ts");
const { ApiError } = await import("../../api/errors.ts");

const SPACES_KEY = ["get", "/api/spaces", { params: { header: { "X-Org-Id": "org_1" } } }];
const refusal = (status: number) =>
  new Response(JSON.stringify({ code: "refused", detail: "refused" }), { status });
const request = (path: string) => new Request(`http://localhost${path}`);
const isInvalidated = (key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated ?? false;

describe("noteStaleAuthority", () => {
  let sessionRefusals: number;

  beforeEach(() => {
    queryClient.clear();
    queryClient.setQueryData(orgKeys.all, []);
    queryClient.setQueryData(SPACES_KEY, { data: [] });
    sessionRefusals = 0;
    setSessionRefusedHandler(() => {
      sessionRefusals += 1;
    });
  });

  it("hands a 401 to the auth seam", () => {
    noteStaleAuthority(request("/api/runs"), refusal(401));

    expect(sessionRefusals).toBe(1);
    expect(isInvalidated(orgKeys.all)).toBe(false);
  });

  it("re-reads the org and space listings on a 403 and on a 404", () => {
    for (const status of [403, 404]) {
      queryClient.setQueryData(orgKeys.all, []);
      queryClient.setQueryData(SPACES_KEY, { data: [] });

      noteStaleAuthority(request("/api/runs?limit=15"), refusal(status));

      expect(isInvalidated(orgKeys.all)).toBe(true);
      expect(isInvalidated(SPACES_KEY)).toBe(true);
    }
    expect(sessionRefusals).toBe(0);
  });

  it("does not re-read a listing because that listing was refused", () => {
    noteStaleAuthority(request("/api/spaces"), refusal(403));
    noteStaleAuthority(request("/api/orgs"), refusal(403));

    expect(isInvalidated(orgKeys.all)).toBe(false);
    expect(isInvalidated(SPACES_KEY)).toBe(false);
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
