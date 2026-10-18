// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { defaultIntegrationManifest } from "../../components/agent-editor/utils.ts";
import {
  mergeDiscovery,
  mergeServerSync,
  hasIntegrationDoc,
  badgeUnder,
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
  it("fills an untouched skeleton and badges every applied field", () => {
    const current = {
      ...defaults,
      source: {
        kind: "remote",
        remote: { url: "https://mcp.notion.com/mcp", transport: "streamable-http" },
      },
    };
    const { manifest, badges } = mergeDiscovery(current, defaults, proposal);
    expect(manifest.display_name).toBe("Notion");
    expect(manifest.name).toBe("@acme/notion");
    expect(manifest.auths).toEqual({ oauth });
    expect((manifest.source as { remote: { transport: string } }).remote.transport).toBe("sse");
    expect(badges).toEqual(proposal.provenance);
    expect(badgeUnder(badges, "/auths")).toBe("detected");
  });

  it("keeps what the author touched and does not badge it", () => {
    const current = {
      ...defaults,
      display_name: "Mon Notion",
      auths: { custom: { type: "api_key", authorized_uris: ["https://x.test/**"] } },
    };
    const { manifest, badges } = mergeDiscovery(current, defaults, proposal);
    expect(manifest.display_name).toBe("Mon Notion");
    expect(manifest.auths).toEqual(current.auths);
    expect(badges["/display_name"]).toBeUndefined();
    expect(badgeUnder(badges, "/auths")).toBeUndefined();
    expect(manifest.name).toBe("@acme/notion");
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
    const { manifest } = mergeDiscovery(current, defaults, proposal);
    expect(manifest.source).toEqual({
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
  const sync = (manifest: Record<string, unknown>) =>
    ({ manifest }) as unknown as Pick<ServerSyncProposal, "manifest">;

  it("replaces default_tools and keeps the policy of tools still listed", () => {
    const current = {
      default_tools: ["a", "gone"],
      tools_policy: {
        a: { required_scopes: { oauth: ["x"] } },
        gone: { required_scopes: { oauth: ["y"] } },
      },
    };
    const { manifest, badges } = mergeServerSync(
      current,
      sync({ default_tools: ["a", "b"], tools_policy: { a: {}, b: {} } }),
    );
    expect(manifest.default_tools).toEqual(["a", "b"]);
    expect(manifest.tools_policy).toEqual({ a: { required_scopes: { oauth: ["x"] } }, b: {} });
    expect(badges["/default_tools"]).toBe("detected");
  });

  it("fills identity only when empty", () => {
    const { manifest, badges } = mergeServerSync(
      { display_name: "Mine", description: "" },
      sync({
        default_tools: [],
        tools_policy: {},
        display_name: "Theirs",
        description: "Server",
        homepage: "https://x.test",
      }),
    );
    expect(manifest.display_name).toBe("Mine");
    expect(manifest.description).toBe("Server");
    expect(manifest.homepage).toBe("https://x.test");
    expect(badges["/display_name"]).toBeUndefined();
    expect(badges["/description"]).toBe("detected");
  });

  it("does not mutate the current manifest", () => {
    const current = { default_tools: ["a"], tools_policy: { a: {} } };
    const copy = structuredClone(current);
    mergeServerSync(current, sync({ default_tools: ["b"], tools_policy: { b: {} } }));
    expect(current).toEqual(copy);
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
