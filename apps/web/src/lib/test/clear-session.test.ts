// SPDX-License-Identifier: Apache-2.0

/**
 * What ends with a session: the signed-in user, every cached answer, and the
 * org/space scope the next requests would carry. What does not: the space each
 * account last chose, which is keyed by user and only ever a candidate.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage();

const { clearSession } = await import("../clear-session.ts");
const { queryClient } = await import("../query-client.ts");
const { authStore } = await import("../../stores/auth-store.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");

describe("clearSession", () => {
  const before = {
    auth: authStore.getState(),
    org: orgStore.getState().id,
    space: spaceStore.getState(),
  };
  afterAll(() => {
    authStore.setState(before.auth);
    orgStore.setState({ id: before.org });
    spaceStore.setState(before.space);
    queryClient.clear();
  });

  it("empties the query cache and the scope, and keeps the remembered spaces", () => {
    authStore.setState({
      user: { id: "usr_a", email: "a@test.com", emailVerified: true },
      profile: { id: "usr_a", displayName: "A", language: "fr", canCreateOrg: true },
      loading: false,
    });
    orgStore.getState().setId("org_a");
    spaceStore.getState().setId("spc_studio");
    const remembered = spaceStore.getState().remembered;
    expect(remembered["usr_a:org_a"]).toBe("spc_studio");
    // The previous account's space listing: the answer a next account must
    // never have its space resolved from.
    queryClient.setQueryData(["get", "/api/spaces"], { data: [{ id: "spc_studio" }] });
    queryClient.setQueryData(["orgs"], [{ id: "org_a" }]);

    clearSession();

    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(authStore.getState().user).toBeNull();
    expect(authStore.getState().profile).toBeNull();
    expect(orgStore.getState().id).toBeNull();
    expect(spaceStore.getState().id).toBeNull();
    expect(spaceStore.getState().remembered).toEqual(remembered);
  });
});
