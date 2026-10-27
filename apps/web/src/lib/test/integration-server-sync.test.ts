// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { ApiError } from "../../api/errors.ts";
import {
  mergeServerSync,
  serverSyncBody,
  syncConnectionCandidates,
  type ServerSyncProposal,
} from "../integration-server-sync.ts";

describe("mergeServerSync", () => {
  const remote = { kind: "remote", remote: { url: "https://x.test/mcp" } };
  const sync = (
    manifest: Record<string, unknown>,
    warnings: { code: string; message: string }[] = [],
  ) => ({ manifest, warnings }) as unknown as Pick<ServerSyncProposal, "manifest" | "warnings">;
  /** The server's answer: every listed tool in `tools_policy`, the read-only ones in `default_tools`. */
  const listing = (names: string[], readOnly: string[] = names) => ({
    default_tools: readOnly,
    tools_policy: Object.fromEntries(names.map((name) => [name, {}])),
  });

  it("keeps the policy of tools still listed, adds new ones and drops the others", () => {
    const current = {
      source: remote,
      tools_policy: {
        a: { required_scopes: { oauth: ["x"] } },
        gone: { required_scopes: { oauth: ["y"] } },
      },
    };
    const manifest = mergeServerSync(current, sync(listing(["a", "b"])));
    expect(manifest.tools_policy).toEqual({ a: { required_scopes: { oauth: ["x"] } }, b: {} });
  });

  it("keeps the draft's tools_policy order so an unchanged server reads as no edit", () => {
    const current = { source: remote, tools_policy: { ping: {}, stats: {}, search: {} } };
    const manifest = mergeServerSync(current, sync(listing(["search", "ping", "stats"])));
    expect(JSON.stringify(manifest.tools_policy)).toBe(JSON.stringify(current.tools_policy));
  });

  it("appends new tools after the draft's order and drops unlisted ones in place", () => {
    const current = { source: remote, tools_policy: { ping: {}, gone: {}, search: {} } };
    const manifest = mergeServerSync(current, sync(listing(["fresh", "search", "ping"])));
    expect(Object.keys(manifest.tools_policy as object)).toEqual(["ping", "search", "fresh"]);
  });

  it("drops no policy entry when the server's list was truncated", () => {
    const current = { source: remote, tools_policy: { kept: { required_scopes: { o: ["s"] } } } };
    const manifest = mergeServerSync(
      current,
      sync(listing(["a"]), [{ code: "tools_truncated", message: "en" }]),
    );
    expect(manifest.tools_policy).toEqual({ kept: { required_scopes: { o: ["s"] } }, a: {} });
  });

  it("fills an absent default_tools with the exposed tools only", () => {
    const current = {
      source: remote,
      hidden_tools: ["secret"],
      auths: { primary: { type: "api_key", connect: { tool: { name: "login" } } } },
    };
    const listed = sync(listing(["a", "secret", "login"]));
    expect(mergeServerSync(current, listed).default_tools).toEqual(["a"]);
  });

  it("declares every listed tool but pre-selects only the read-only ones", () => {
    const manifest = mergeServerSync(
      { source: remote },
      sync(listing(["read", "delete"], ["read"])),
    );
    expect(manifest.tools_policy).toEqual({ read: {}, delete: {} });
    expect(manifest.default_tools).toEqual(["read"]);
  });

  it("keeps an explicitly empty default_tools", () => {
    const current = {
      source: remote,
      default_tools: [],
      tools_policy: { read: {}, delete: {} },
    };
    const proposed = sync(listing(["read", "delete"]));
    expect(mergeServerSync(current, proposed).default_tools).toEqual([]);
  });

  it("never adds to the author's default_tools, only removes tools no longer exposed", () => {
    const current = { source: remote, default_tools: ["a", "gone"], tools_policy: { a: {} } };
    const manifest = mergeServerSync(current, sync(listing(["a", "b"])));
    expect(manifest.default_tools).toEqual(["a"]);
  });

  it("keeps a wildcard default_tools", () => {
    const current = { source: remote, default_tools: "*" };
    expect(mergeServerSync(current, sync(listing(["a"]))).default_tools).toBe("*");
  });

  it("handles a tool named like an Object.prototype member", () => {
    const manifest = mergeServerSync(
      { source: remote, tools_policy: {} },
      sync(listing(["constructor", "toString"])),
    );
    expect(manifest.tools_policy).toEqual({ constructor: {}, toString: {} });
    expect(manifest.default_tools).toEqual(["constructor", "toString"]);
  });

  it("fills identity only when empty", () => {
    const proposed = {
      ...listing([]),
      display_name: "Theirs",
      description: "Server",
      homepage: "https://x.test",
    };
    const manifest = mergeServerSync({ display_name: "Mine", description: "" }, sync(proposed));
    expect(manifest.display_name).toBe("Mine");
    expect(manifest.description).toBe("Server");
    expect(manifest.homepage).toBe("https://x.test");
  });

  it("does not mutate the current manifest", () => {
    const current = { source: remote, default_tools: ["a"], tools_policy: { a: {} } };
    const copy = structuredClone(current);
    mergeServerSync(current, sync(listing(["b"])));
    expect(current).toEqual(copy);
  });
});

describe("serverSyncBody", () => {
  it("lets the proxy apply governance and choose on the initial request", () => {
    expect(serverSyncBody()).toEqual({});
  });

  it("names only a connection the caller explicitly selected", () => {
    expect(serverSyncBody("chosen")).toEqual({ connection_id: "chosen" });
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
