// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  mergeServerIdentity,
  serverReadAvailability,
  connectionChoiceBody,
  syncConnectionCandidates,
} from "../integration-server-sync.ts";

describe("connectionChoiceBody", () => {
  it("lets the proxy apply governance and choose on the initial request", () => {
    expect(connectionChoiceBody()).toEqual({});
  });

  it("names only a connection the caller explicitly selected", () => {
    expect(connectionChoiceBody("chosen")).toEqual({ connection_id: "chosen" });
  });
});

describe("sync connection choice", () => {
  const candidate = {
    id: "conn_b",
    label: "Notion",
    account_id: "b@acme.test",
    owned_by_actor: true,
    needs_reconnection: false,
    scopes_granted: [],
    missing_scopes: [],
  };
  const refusal = (code: string) =>
    new ApiError(code, "en", 409, [
      { field: "integrations.@acme/notion", code, candidate_connections: [candidate] },
    ]);

  it("reads the candidates of a must_choose_connection refusal", () => {
    expect(syncConnectionCandidates(refusal("must_choose_connection"))).toEqual([candidate]);
    expect(syncConnectionCandidates(refusal("needs_reconnection"))).toBeNull();
    expect(syncConnectionCandidates(new Error("x"))).toBeNull();
  });
});

describe("mergeServerIdentity", () => {
  it("fills only the empty identity fields and reports them", () => {
    const { manifest, filled } = mergeServerIdentity(
      { display_name: "Mine", description: "", keywords: [] },
      {
        display_name: "Server",
        description: "From server",
        homepage: "https://x.test",
        icon: "data:",
      },
    );
    expect(manifest).toMatchObject({
      display_name: "Mine",
      description: "From server",
      homepage: "https://x.test",
      icon: "data:",
    });
    expect(filled).toEqual(["description", "homepage", "icon"]);
  });

  it("never overwrites an authored field and reports nothing when all are set", () => {
    const current = { display_name: "A", description: "B", homepage: "C", icon: "D" };
    const { manifest, filled } = mergeServerIdentity(current, {
      display_name: "x",
      description: "y",
      homepage: "z",
      icon: "w",
    });
    expect(manifest).toEqual(current);
    expect(filled).toEqual([]);
  });

  it("skips what the server does not propose", () => {
    expect(mergeServerIdentity({}, { display_name: "S" }).filled).toEqual(["display_name"]);
  });
});

describe("serverReadAvailability", () => {
  const ok = { unauthenticated: false, mayProxy: true, hasConnection: true };
  const remote = { kind: "remote", transport: "streamable-http" };

  it("is null for a source that is not remote", () => {
    expect(serverReadAvailability({ kind: "local" }, ok)).toBeNull();
    expect(serverReadAvailability(undefined, ok)).toBeNull();
  });

  it("blocks SSE whatever the access", () => {
    expect(serverReadAvailability({ kind: "remote", transport: "sse" }, ok)).toBe("sse");
  });

  it("needs no proxy right nor connection when the draft declares no auths", () => {
    expect(
      serverReadAvailability(remote, {
        unauthenticated: true,
        mayProxy: false,
        hasConnection: false,
      }),
    ).toBe("available");
  });

  it("blocks without the proxy right, then without a connection", () => {
    expect(serverReadAvailability(remote, { ...ok, mayProxy: false })).toBe("no_permission");
    expect(serverReadAvailability(remote, { ...ok, hasConnection: false })).toBe("no_connection");
    expect(serverReadAvailability(remote, ok)).toBe("available");
  });
});
