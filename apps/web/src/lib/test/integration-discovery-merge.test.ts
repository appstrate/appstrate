// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { defaultIntegrationManifest } from "../../components/agent-editor/utils.ts";
import { getSource, setSource } from "../../components/integration-editor/utils.ts";
import { ApiError } from "../../api/errors.ts";
import {
  mergeDiscovery,
  mergeServerSync,
  badgeUnder,
  proposalBadges,
  serverSyncProvenance,
  serverSyncBody,
  syncConnectionCandidates,
  type DiscoveryProposal,
  type ServerSyncProposal,
} from "../integration-discovery-merge.ts";

const defaults = defaultIntegrationManifest("acme", "me@acme.test");
const NOTION = "https://mcp.notion.com/mcp";

const oauth = { type: "oauth2", authorized_uris: ["https://mcp.notion.com/**"] };
const proposal = {
  manifest: {
    display_name: "Notion",
    name: "@acme/notion",
    documentation: "https://developers.notion.com",
    icon: "data:image/png;base64,AAAA",
    source: { kind: "remote", remote: { url: "https://mcp.notion.com/mcp", transport: "sse" } },
    auths: { oauth },
  },
  icon_source: null,
  provenance: {
    "/display_name": "detected",
    "/name": "guessed",
    "/documentation": "detected",
    "/icon": "detected",
    "/source/remote/transport": "guessed",
    "/auths/oauth": "detected",
  },
  warnings: [],
} as unknown as DiscoveryProposal;

describe("mergeDiscovery", () => {
  const LINEAR = "https://mcp.linear.app/mcp";
  // The skeleton once the author typed the URL being analysed.
  const withNotion = setSource(defaults, { ...getSource(defaults), remoteUrl: NOTION });

  it("fills an untouched skeleton", () => {
    const current = {
      ...defaults,
      source: {
        kind: "remote",
        remote: { url: "https://mcp.notion.com/mcp", transport: "streamable-http" },
      },
    };
    const manifest = mergeDiscovery(current, defaults, proposal, NOTION);
    expect(manifest.display_name).toBe("Notion");
    expect(manifest.name).toBe("@acme/notion");
    expect(manifest.auths).toEqual({ oauth });
    expect((manifest.source as { remote: { transport: string } }).remote.transport).toBe("sse");
    const badges = proposalBadges(manifest, proposal);
    expect(badges).toEqual(proposal.provenance);
    expect(badgeUnder(badges, "/auths")).toBe("detected");
  });

  it("treats the skeleton auth as untouched once typing the URL moved its allowlist", () => {
    // What the source field does on every keystroke: the skeleton's auth follows the URL's host.
    const current = setSource(defaults, {
      ...getSource(defaults),
      remoteUrl: "https://mcp.notion.com/mcp",
    });
    expect(
      (current.auths as Record<string, { authorized_uris: string[] }>).primary!.authorized_uris,
    ).toEqual(["https://mcp.notion.com/**"]);
    expect(mergeDiscovery(current, defaults, proposal, NOTION).auths).toEqual({ oauth });
  });

  it("keeps what the author touched and does not badge it", () => {
    const current = {
      ...withNotion,
      display_name: "Mon Notion",
      auths: { custom: { type: "api_key", authorized_uris: ["https://x.test/**"] } },
    };
    const manifest = mergeDiscovery(current, defaults, proposal, NOTION);
    expect(manifest.display_name).toBe("Mon Notion");
    expect(manifest.auths).toEqual(current.auths);
    expect(manifest.name).toBe("@acme/notion");
    const badges = proposalBadges(manifest, proposal);
    expect(badges["/display_name"]).toBeUndefined();
    expect(badgeUnder(badges, "/auths")).toBeUndefined();
  });

  it("replaces a first analysis with a second one, but not the author's edits since", () => {
    const linearAuth = { type: "oauth2", authorized_uris: ["https://mcp.linear.app/**"] };
    const second = {
      ...proposal,
      manifest: {
        display_name: "Linear",
        name: "@acme/linear",
        source: { kind: "remote", remote: { url: LINEAR, transport: "sse" } },
        auths: { oauth: linearAuth },
      },
    } as unknown as DiscoveryProposal;
    const first = mergeDiscovery(withNotion, defaults, proposal, NOTION);
    // The author typed the second URL before analysing it.
    const retyped = setSource(first, { ...getSource(first), remoteUrl: LINEAR });
    const manifest = mergeDiscovery(retyped, defaults, second, LINEAR, proposal.manifest);
    expect(manifest.display_name).toBe("Linear");
    expect(manifest.name).toBe("@acme/linear");
    expect(manifest.auths).toEqual({ oauth: linearAuth });

    const edited = mergeDiscovery(
      { ...retyped, display_name: "Mine" },
      defaults,
      second,
      LINEAR,
      proposal.manifest,
    );
    expect(edited.display_name).toBe("Mine");
  });

  it("drops a badge once the author edits the field", () => {
    const manifest = mergeDiscovery(withNotion, defaults, proposal, NOTION);
    const badges = proposalBadges(
      { ...manifest, auths: { oauth: { ...oauth, client_id: "x" } } },
      proposal,
    );
    expect(badgeUnder(badges, "/auths")).toBeUndefined();
    expect(badges["/display_name"]).toBe("detected");
  });

  it("takes the analysed transport, and keeps unrelated source keys", () => {
    const current = {
      ...defaults,
      source: { kind: "remote", server: { name: "x" }, remote: { url: NOTION, extra: 1 } },
    };
    expect(mergeDiscovery(current, defaults, proposal, NOTION).source).toEqual({
      kind: "remote",
      server: { name: "x" },
      remote: { url: NOTION, extra: 1, transport: "sse" },
    });
  });

  it("drops an answer for a URL the author corrected while it was pending", () => {
    const current = {
      source: {
        kind: "remote",
        remote: { url: "https://new.example/mcp", transport: "streamable-http" },
      },
    };
    const stale = {
      manifest: {
        display_name: "Old",
        name: "@acme/old",
        auths: {},
        source: { kind: "remote", remote: { url: "https://old.example/sse", transport: "sse" } },
      },
    } as unknown as DiscoveryProposal;
    expect(mergeDiscovery(current, {}, stale, "https://old.example/mcp")).toBe(current);
  });

  it("drops an answer once the source was switched to local", () => {
    const current = { ...withNotion, source: { kind: "local", server: { name: "x" } } };
    expect(mergeDiscovery(current, defaults, proposal, NOTION)).toBe(current);
  });

  it("does not mutate its inputs", () => {
    const current = structuredClone(withNotion);
    mergeDiscovery(current, defaults, proposal, NOTION);
    expect(current).toEqual(withNotion);
  });
});

describe("mergeServerSync", () => {
  const remote = { kind: "remote", remote: { url: "https://x.test/mcp" } };
  const sync = (
    manifest: Record<string, unknown>,
    warnings: { code: string; message: string }[] = [],
  ) => ({ manifest, warnings }) as unknown as Pick<ServerSyncProposal, "manifest" | "warnings">;

  it("keeps the policy of tools still listed, adds new ones and drops the others", () => {
    const current = {
      source: remote,
      tools_policy: {
        a: { required_scopes: { oauth: ["x"] } },
        gone: { required_scopes: { oauth: ["y"] } },
      },
    };
    const manifest = mergeServerSync(current, sync({ default_tools: ["a", "b"] }));
    expect(manifest.tools_policy).toEqual({ a: { required_scopes: { oauth: ["x"] } }, b: {} });
  });

  it("drops no policy entry when the server's list was truncated", () => {
    const current = { source: remote, tools_policy: { kept: { required_scopes: { o: ["s"] } } } };
    const manifest = mergeServerSync(
      current,
      sync({ default_tools: ["a"] }, [{ code: "tools_truncated", message: "en" }]),
    );
    expect(manifest.tools_policy).toEqual({ kept: { required_scopes: { o: ["s"] } }, a: {} });
  });

  it("fills an absent default_tools with the exposed tools only", () => {
    const current = {
      source: remote,
      hidden_tools: ["secret"],
      auths: { primary: { type: "api_key", connect: { tool: { name: "login" } } } },
    };
    const listed = sync({ default_tools: ["a", "secret", "login"] });
    expect(mergeServerSync(current, listed).default_tools).toEqual(["a"]);
  });

  it("keeps an explicitly empty default_tools", () => {
    const current = {
      source: remote,
      default_tools: [],
      tools_policy: { read: {}, delete: {} },
    };
    const proposed = sync({
      default_tools: ["read", "delete"],
      tools_policy: { read: {}, delete: {} },
    });
    expect(mergeServerSync(current, proposed).default_tools).toEqual([]);
  });

  it("never adds to the author's default_tools, only removes tools no longer exposed", () => {
    const current = { source: remote, default_tools: ["a", "gone"], tools_policy: { a: {} } };
    const manifest = mergeServerSync(current, sync({ default_tools: ["a", "b"] }));
    expect(manifest.default_tools).toEqual(["a"]);
  });

  it("keeps a wildcard default_tools", () => {
    const current = { source: remote, default_tools: "*" };
    expect(mergeServerSync(current, sync({ default_tools: ["a"] })).default_tools).toBe("*");
  });

  it("handles a tool named like an Object.prototype member", () => {
    const manifest = mergeServerSync(
      { source: remote, tools_policy: {} },
      sync({ default_tools: ["constructor", "toString"] }),
    );
    expect(manifest.tools_policy).toEqual({ constructor: {}, toString: {} });
    expect(manifest.default_tools).toEqual(["constructor", "toString"]);
  });

  it("fills identity only when empty", () => {
    const proposed = {
      default_tools: [],
      display_name: "Theirs",
      description: "Server",
      homepage: "https://x.test",
    };
    const manifest = mergeServerSync({ display_name: "Mine", description: "" }, sync(proposed));
    expect(manifest.display_name).toBe("Mine");
    expect(manifest.description).toBe("Server");
    expect(manifest.homepage).toBe("https://x.test");
    // Only the fields the sync filled keep a badge: the author's display name is kept as is.
    const badges = proposalBadges(manifest, serverSyncProvenance(sync(proposed)));
    expect(badges).toEqual({
      "/default_tools": "detected",
      "/description": "detected",
      "/homepage": "detected",
    });
  });

  it("does not mutate the current manifest", () => {
    const current = { source: remote, default_tools: ["a"], tools_policy: { a: {} } };
    const copy = structuredClone(current);
    mergeServerSync(current, sync({ default_tools: ["b"] }));
    expect(current).toEqual(copy);
  });
});

describe("serverSyncBody", () => {
  const connection = (
    id: string,
    over: Partial<{ owner_id: string; needs_reconnection: boolean }> = {},
  ) => ({
    id,
    owner_type: "user" as const,
    owner_id: "u1",
    needs_reconnection: false,
    ...over,
  });

  it("names the caller's one own connection, other members' aside", () => {
    const auths = [
      { connections: [connection("theirs", { owner_id: "u2" })] },
      { connections: [connection("mine")] },
    ];
    expect(serverSyncBody(auths, "u1")).toEqual({ connection_id: "mine" });
  });

  it("names none between two own accounts: the proxy asks for a choice", () => {
    const auths = [{ connections: [connection("account-A"), connection("account-B")] }];
    expect(serverSyncBody(auths, "u1")).toEqual({});
  });

  it("names none when one own account is dead and another lives: no silent switch", () => {
    const auths = [
      { connections: [connection("A", { needs_reconnection: true }), connection("B")] },
    ];
    expect(serverSyncBody(auths, "u1")).toEqual({});
  });

  it("names one own live account", () => {
    expect(serverSyncBody([{ connections: [connection("only")] }], "u1")).toEqual({
      connection_id: "only",
    });
  });

  it("names none without an own usable connection: the proxy selects", () => {
    const auths = [
      {
        connections: [
          connection("theirs", { owner_id: "u2" }),
          connection("dead", { needs_reconnection: true }),
        ],
      },
    ];
    expect(serverSyncBody(auths, "u1")).toEqual({});
    expect(serverSyncBody(auths, undefined)).toEqual({});
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
