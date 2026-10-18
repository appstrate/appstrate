// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { defaultIntegrationManifest } from "../../components/agent-editor/utils.ts";
import { getSource, setSource } from "../../components/integration-editor/utils.ts";
import {
  mergeDiscovery,
  mergeServerSync,
  hasIntegrationDoc,
  badgeUnder,
  proposalBadges,
  serverSyncProvenance,
  serverSyncBody,
  type DiscoveryProposal,
  type ServerSyncProposal,
} from "../integration-discovery-merge.ts";

const defaults = defaultIntegrationManifest("acme", "me@acme.test");

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
  it("fills an untouched skeleton", () => {
    const current = {
      ...defaults,
      source: {
        kind: "remote",
        remote: { url: "https://mcp.notion.com/mcp", transport: "streamable-http" },
      },
    };
    const manifest = mergeDiscovery(current, defaults, proposal);
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
    expect(mergeDiscovery(current, defaults, proposal).auths).toEqual({ oauth });
  });

  it("keeps what the author touched and does not badge it", () => {
    const current = {
      ...defaults,
      display_name: "Mon Notion",
      auths: { custom: { type: "api_key", authorized_uris: ["https://x.test/**"] } },
    };
    const manifest = mergeDiscovery(current, defaults, proposal);
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
        source: { kind: "remote", remote: { url: "https://mcp.linear.app/mcp", transport: "sse" } },
        auths: { oauth: linearAuth },
      },
    } as unknown as DiscoveryProposal;
    const first = mergeDiscovery(defaults, defaults, proposal);
    const manifest = mergeDiscovery(first, defaults, second, proposal.manifest);
    expect(manifest.display_name).toBe("Linear");
    expect(manifest.name).toBe("@acme/linear");
    expect(manifest.auths).toEqual({ oauth: linearAuth });

    const edited = mergeDiscovery(
      { ...first, display_name: "Mine" },
      defaults,
      second,
      proposal.manifest,
    );
    expect(edited.display_name).toBe("Mine");
  });

  it("drops a badge once the author edits the field", () => {
    const manifest = mergeDiscovery(defaults, defaults, proposal);
    const badges = proposalBadges(
      { ...manifest, auths: { oauth: { ...oauth, client_id: "x" } } },
      proposal,
    );
    expect(badgeUnder(badges, "/auths")).toBeUndefined();
    expect(badges["/display_name"]).toBe("detected");
  });

  it("always takes the analysed URL and transport, and keeps unrelated source keys", () => {
    const current = {
      ...defaults,
      source: {
        kind: "local",
        server: { name: "x" },
        remote: { url: "https://old.test", extra: 1 },
      },
    };
    expect(mergeDiscovery(current, defaults, proposal).source).toEqual({
      kind: "remote",
      server: { name: "x" },
      remote: { url: "https://mcp.notion.com/mcp", extra: 1, transport: "sse" },
    });
  });

  it("does not mutate its inputs", () => {
    const current = structuredClone(defaults);
    mergeDiscovery(current, defaults, proposal);
    expect(current).toEqual(defaults);
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

  it("fills an absent or empty default_tools with the exposed tools only", () => {
    const current = {
      source: remote,
      hidden_tools: ["secret"],
      auths: { primary: { type: "api_key", connect: { tool: { name: "login" } } } },
    };
    const listed = sync({ default_tools: ["a", "secret", "login"] });
    expect(mergeServerSync(current, listed).default_tools).toEqual(["a"]);
    expect(mergeServerSync({ ...current, default_tools: [] }, listed).default_tools).toEqual(["a"]);
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
    over: Partial<{ owner_id: string; needs_reconnection: boolean; locked_by: string | null }> = {},
  ) => ({
    id,
    owner_type: "user" as const,
    owner_id: "u1",
    needs_reconnection: false,
    locked_by: null,
    ...over,
  });

  it("names the caller's own usable connection, a locked one first", () => {
    const auths = [
      {
        connections: [
          connection("theirs", { owner_id: "u2" }),
          connection("dead", { needs_reconnection: true }),
        ],
      },
      { connections: [connection("first"), connection("pinned", { locked_by: "org_default" })] },
    ];
    expect(serverSyncBody(auths, "u1")).toEqual({ connection_id: "pinned" });
    expect(
      serverSyncBody([{ connections: [connection("first"), connection("second")] }], "u1"),
    ).toEqual({
      connection_id: "first",
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

describe("hasIntegrationDoc", () => {
  it("tells an authored markdown from the manifest text a draft falls back to", () => {
    expect(hasIntegrationDoc("# Notion\n\nUse it.")).toBe(true);
    expect(hasIntegrationDoc('{"name":"@a/b"}')).toBe(false);
    expect(hasIntegrationDoc("")).toBe(false);
    expect(hasIntegrationDoc(null)).toBe(false);
  });
});
