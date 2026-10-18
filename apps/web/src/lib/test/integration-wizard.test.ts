// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { defaultIntegrationManifest } from "../../components/agent-editor/utils.ts";
import { packageCreateBody } from "../package-file-drafts.ts";
import type { ServerSyncProposal } from "../integration-server-sync.ts";
import { ApiError } from "../../api/errors.ts";
import {
  defaultToolCount,
  catalogConnectionsKey,
  catalogSourceKey,
  connectBlocker,
  draftChangesBeyondWizard,
  isStalePublish,
  sameAuths,
  syncConnectionRemedy,
  docsChoice,
  initialToolSelection,
  integrationCreationManifest,
  integrationWizardStep,
  isCurrentAnalysis,
  isRemoteSource,
  manualCreationState,
  needsWizardFinish,
  proposalEdits,
  readManualCreationManifest,
  toolsPublishVersion,
  toolsUpdateBody,
  wizardAuthKind,
  wizardCreateBody,
  wizardResumePath,
  type DiscoveryResult,
} from "../integration-wizard.ts";

const oauth = {
  type: "oauth2",
  token_endpoint_auth_method: "none",
  default_scopes: [],
  authorized_uris: ["https://mcp.acme.test/**"],
};
const proposal = {
  display_name: "Acme",
  name: "@org/acme",
  source: {
    kind: "remote",
    remote: { url: "https://mcp.acme.test/mcp", transport: "streamable-http" },
  },
  auths: { oauth },
} as unknown as DiscoveryResult["manifest"];

describe("integrationCreationManifest", () => {
  const defaults = defaultIntegrationManifest("org", "me@acme.test");

  it("replaces the default API key auth with the proposal's and applies the edits", () => {
    const manifest = integrationCreationManifest(defaults, proposal, {
      display_name: " Acme MCP ",
      name: " @org/acme-mcp ",
    });
    expect(manifest.auths).toEqual({ oauth });
    expect(manifest.display_name).toBe("Acme MCP");
    expect(manifest.name).toBe("@org/acme-mcp");
    expect(manifest.source).toEqual(proposal.source);
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author).toBe("me@acme.test");
    expect(manifest).not.toHaveProperty("icon");
  });

  it("carries the icon, the proposal's or the re-encoded one", () => {
    const withIcon = { ...proposal, icon: "data:image/png;base64,AAA" };
    expect(integrationCreationManifest(defaults, withIcon, proposalEdits(withIcon)).icon).toBe(
      "data:image/png;base64,AAA",
    );
    expect(
      integrationCreationManifest(defaults, proposal, proposalEdits(proposal), "data:x").icon,
    ).toBe("data:x");
  });

  it("is sent as the create route's body", () => {
    const manifest = integrationCreationManifest(defaults, proposal, proposalEdits(proposal));
    expect(packageCreateBody({ manifest }, "integration")).toEqual({
      manifest,
      content: JSON.stringify(manifest, null, 2),
    });
  });

  it("is created by the wizard as a draft only, through the same payload builder", () => {
    const manifest = integrationCreationManifest(defaults, proposal, proposalEdits(proposal));
    expect(wizardCreateBody(manifest)).toEqual({
      ...packageCreateBody({ manifest }, "integration"),
      publish: false,
    });
    expect(wizardCreateBody(manifest).manifest.version).toBe("1.0.0");
  });

  it("reaches the manual editor through router state only as an object", () => {
    const manifest = integrationCreationManifest(defaults, proposal, proposalEdits(proposal));
    expect(readManualCreationManifest(manualCreationState(manifest))).toBe(manifest);
    expect(readManualCreationManifest({ integrationManifest: [] })).toBeUndefined();
    expect(readManualCreationManifest(null)).toBeUndefined();
  });
});

describe("wizardAuthKind", () => {
  it("tells an automatic OAuth client from one an administrator registers", () => {
    expect(wizardAuthKind(oauth)).toBe("oauthAuto");
    expect(wizardAuthKind({ ...oauth, token_endpoint_auth_method: "client_secret_post" })).toBe(
      "oauthAdmin",
    );
    expect(wizardAuthKind({ type: "api_key" })).toBe("apiKey");
    expect(wizardAuthKind({ type: "basic" })).toBe("other");
  });
});

describe("integrationWizardStep", () => {
  it("reads the step from the package alone", () => {
    const facts = {
      remote: true,
      active: true,
      published: true,
      connection: "ready" as const,
      toolsDeclared: false,
    };
    expect(integrationWizardStep({ ...facts, remote: false })).toBe("notRemote");
    expect(integrationWizardStep({ ...facts, connection: "none" })).toBe("connect");
    expect(integrationWizardStep(facts)).toBe("tools");
    expect(integrationWizardStep({ ...facts, toolsDeclared: true })).toBe("ready");
  });

  it("goes from connecting to the tools on a draft never published", () => {
    const draft = {
      remote: true,
      active: true,
      published: false,
      connection: "none" as const,
      toolsDeclared: false,
    };
    expect(integrationWizardStep(draft)).toBe("connect");
    expect(integrationWizardStep({ ...draft, connection: "ready" })).toBe("tools");
    // A draft that declares tools (saved, its publish failed) is not ready: nothing is published.
    expect(
      integrationWizardStep({ ...draft, connection: "ready" as const, toolsDeclared: true }),
    ).toBe("tools");
  });

  it("is not ready while no usable connection exists, tools declared or not", () => {
    const facts = {
      remote: true,
      active: true,
      published: true,
      connection: "none" as const,
      toolsDeclared: true,
    };
    expect(integrationWizardStep(facts)).toBe("connect");
  });
});

describe("integrationWizardStep — governed connection", () => {
  const facts = {
    remote: true,
    active: true,
    published: true,
    connection: "ready" as const,
    toolsDeclared: true,
  };

  it("proceeds on the proxy's verdict alone: ready, or a choice the tools step asks for", () => {
    expect(integrationWizardStep(facts)).toBe("ready");
    expect(integrationWizardStep({ ...facts, connection: "must_choose" })).toBe("ready");
    expect(
      integrationWizardStep({ ...facts, connection: "must_choose", toolsDeclared: false }),
    ).toBe("tools");
  });

  it("stays at the connect step on every verdict a call would be refused with", () => {
    for (const connection of [
      "none",
      "needs_reconnection",
      "not_permitted",
      "default_unavailable",
      "unusable",
    ] as const) {
      expect(integrationWizardStep({ ...facts, connection })).toBe("connect");
    }
  });
});

describe("connectBlocker", () => {
  it("offers a personal connection only where one can change the verdict", () => {
    expect(connectBlocker({ status: "none", imposed: false })).toEqual({
      blocker: "none",
      offerConnect: true,
    });
    expect(connectBlocker({ status: "needs_reconnection", imposed: false })).toEqual({
      blocker: "reconnect",
      offerConnect: true,
    });
    expect(connectBlocker({ status: "needs_reconnection", imposed: true })).toEqual({
      blocker: "reconnectImposed",
      offerConnect: false,
    });
    expect(connectBlocker({ status: "not_permitted", imposed: true })).toEqual({
      blocker: "notPermittedImposed",
      offerConnect: false,
    });
    // Not imposed: the caller holds no proxy permission at all.
    expect(connectBlocker({ status: "not_permitted", imposed: false })).toEqual({
      blocker: "notPermitted",
      offerConnect: false,
    });
    expect(connectBlocker({ status: "default_unavailable", imposed: false })).toEqual({
      blocker: "defaultUnavailable",
      offerConnect: false,
    });
    expect(connectBlocker({ status: "unusable", imposed: false })).toEqual({
      blocker: "unusable",
      offerConnect: true,
    });
    expect(connectBlocker({ status: "unusable", imposed: true })).toEqual({
      blocker: "unusableImposed",
      offerConnect: false,
    });
  });
});

describe("integrationWizardStep — activation", () => {
  it("is never ready, nor at a later step, while switched off in this space", () => {
    const ready = {
      remote: true,
      active: false,
      published: true,
      connection: "ready" as const,
      toolsDeclared: true,
    };
    expect(integrationWizardStep(ready)).toBe("inactive");
    expect(integrationWizardStep({ ...ready, connection: "none" })).toBe("inactive");
    expect(integrationWizardStep({ ...ready, remote: false })).toBe("notRemote");
    expect(integrationWizardStep({ ...ready, active: true })).toBe("ready");
  });
});

describe("catalogSourceKey", () => {
  const draft = {
    name: "@org/acme",
    display_name: "Acme",
    source: proposal.source,
    auths: { oauth },
  };

  it("changes with the server the catalogue is read from", () => {
    const key = catalogSourceKey(draft);
    const elsewhere = {
      ...draft,
      source: {
        kind: "remote",
        remote: { url: "https://b.test/mcp", transport: "streamable-http" },
      },
    };
    expect(catalogSourceKey(elsewhere)).not.toBe(key);
    const sse = {
      ...draft,
      source: { kind: "remote", remote: { url: "https://mcp.acme.test/mcp", transport: "sse" } },
    };
    expect(catalogSourceKey(sse)).not.toBe(key);
  });

  it("changes with the auths the proxy authorizes the read with", () => {
    const key = catalogSourceKey(draft);
    expect(catalogSourceKey({ ...draft, auths: { primary: oauth } })).not.toBe(key);
    expect(
      catalogSourceKey({ ...draft, auths: { oauth: { ...oauth, type: "api_key" } } }),
    ).not.toBe(key);
    expect(
      catalogSourceKey({
        ...draft,
        auths: { oauth: { ...oauth, authorized_uris: ["https://b.test/**"] } },
      }),
    ).not.toBe(key);
  });

  it("stays the same across edits the read does not depend on, auth order included", () => {
    const key = catalogSourceKey({ ...draft, auths: { a: oauth, b: { type: "api_key" } } });
    expect(
      catalogSourceKey({
        ...draft,
        display_name: "Renamed",
        auths: { b: { type: "api_key" }, a: oauth },
      }),
    ).toBe(key);
  });
});

describe("isRemoteSource", () => {
  it("handles only a remote MCP source", () => {
    expect(isRemoteSource({ source: proposal.source })).toBe(true);
    expect(isRemoteSource({ source: { kind: "local", server: { name: "@org/x" } } })).toBe(false);
    expect(isRemoteSource({ source: { kind: "none" } })).toBe(false);
  });
});

describe("isCurrentAnalysis", () => {
  it("drops an answer for an address the input no longer holds", () => {
    expect(isCurrentAnalysis(" https://a.test/mcp ", "https://a.test/mcp")).toBe(true);
    expect(isCurrentAnalysis("https://b.test/mcp", "https://a.test/mcp")).toBe(false);
  });
});

describe("toolsPublishVersion", () => {
  it("publishes the draft's own version first", () => {
    expect(
      toolsPublishVersion({ published: false, publishedVersion: undefined, draftVersion: "1.0.0" }),
    ).toBe("1.0.0");
    expect(
      toolsPublishVersion({ published: false, publishedVersion: undefined, draftVersion: 3 }),
    ).toBeNull();
  });

  it("bumps the minor of the published version afterwards", () => {
    const base = { published: true, draftVersion: "1.0.0" };
    expect(toolsPublishVersion({ ...base, publishedVersion: "1.0.0" })).toBe("1.1.0");
    expect(toolsPublishVersion({ ...base, publishedVersion: "2.3.4" })).toBe("2.4.0");
    expect(toolsPublishVersion({ ...base, publishedVersion: undefined })).toBeNull();
  });
});

describe("toolsPublishVersion — never lower", () => {
  it("keeps a draft version already past the next minor, and labels that one", () => {
    const facts = { published: true, publishedVersion: "1.0.0" };
    expect(toolsPublishVersion({ ...facts, draftVersion: "2.0.0" })).toBe("2.0.0");
    expect(toolsPublishVersion({ ...facts, draftVersion: "1.1.0" })).toBe("1.1.0");
    expect(toolsPublishVersion({ ...facts, draftVersion: "1.0.5" })).toBe("1.1.0");
    // A draft version that is not semver never wins.
    expect(toolsPublishVersion({ ...facts, draftVersion: "next" })).toBe("1.1.0");
  });
});

describe("isStalePublish", () => {
  it("re-saves only on a publish refused because the draft moved (412)", () => {
    expect(isStalePublish(new ApiError("precondition_failed", "moved", 412))).toBe(true);
    expect(isStalePublish(new ApiError("version_exists", "taken", 409))).toBe(false);
    expect(isStalePublish(new Error("network"))).toBe(false);
  });
});

describe("syncConnectionRemedy", () => {
  const missing = new ApiError("integration_not_connected", "none", 409);
  const dead = new ApiError("needs_reconnection", "dead", 409);

  it("connects when nothing is published or the draft keeps the published auths", () => {
    for (const error of [missing, dead]) {
      expect(syncConnectionRemedy(error, { published: false, authsMatch: false })).toBe("connect");
      expect(syncConnectionRemedy(error, { published: true, authsMatch: true })).toBe("connect");
    }
  });

  it("says the draft's authentication is unpublished when a connect cannot clear it", () => {
    for (const error of [missing, dead]) {
      expect(syncConnectionRemedy(error, { published: true, authsMatch: false })).toBe(
        "unpublishedAuths",
      );
    }
  });

  it("leaves every other error to the ordinary error state", () => {
    const facts = { published: true, authsMatch: true };
    expect(syncConnectionRemedy(new ApiError("must_choose_connection", "pick", 409), facts)).toBe(
      null,
    );
    expect(syncConnectionRemedy(new ApiError("bad_gateway", "down", 502), facts)).toBeNull();
    expect(syncConnectionRemedy(null, facts)).toBeNull();
  });
});

describe("sameAuths", () => {
  it("compares the auths whatever their key order", () => {
    const reordered = { auths: { oauth: Object.fromEntries(Object.entries(oauth).reverse()) } };
    expect(sameAuths(reordered, { auths: { oauth } })).toBe(true);
    expect(
      sameAuths({ auths: { oauth: { ...oauth, type: "api_key" } } }, { auths: { oauth } }),
    ).toBe(false);
  });
});

describe("draftChangesBeyondWizard", () => {
  const published = {
    name: "@org/acme",
    version: "1.0.0",
    display_name: "Acme",
    description: "",
    source: proposal.source,
    auths: { oauth },
    tools_policy: { search: { required_scopes: { oauth: ["read"] } } },
    default_tools: ["search"],
  };
  /** The server lists `search` and `fetch`, complete or cut. */
  const sync = (truncated = false) =>
    ({
      manifest: {
        default_tools: ["search"],
        tools_policy: { search: {}, fetch: {} },
        description: "From the server",
        homepage: "https://acme.example/",
      },
      warnings: truncated ? [{ code: "tools_truncated", message: "…" }] : [],
    }) as unknown as Pick<ServerSyncProposal, "manifest" | "warnings">;
  const check = (draft: Record<string, unknown>, unarchivedAtMount = false, truncated = false) =>
    draftChangesBeyondWizard({ draft, published, proposal: sync(truncated), unarchivedAtMount });
  /** What the wizard's save leaves: tools merged, selection and version set, empty identity filled. */
  const savedByWizard = {
    ...published,
    version: "1.1.0",
    description: "From the server",
    homepage: "https://acme.example/",
    tools_policy: { search: { required_scopes: { oauth: ["read"] } }, fetch: {} },
    default_tools: ["search", "fetch"],
    // Same values, another key order.
    auths: { oauth: Object.fromEntries(Object.entries(oauth).reverse()) },
  };

  it("says nothing about what the wizard itself writes (a reload after its failed publish)", () => {
    expect(check(savedByWizard)).toBe(false);
    // The draft holding changes at mount is the wizard's own save: it declares the listed tools.
    expect(check(savedByWizard, true)).toBe(false);
    // Before any save, an untouched draft ships nothing else either.
    expect(check(published)).toBe(false);
  });

  it("says nothing about an edit to a tool the server no longer lists: the save drops it", () => {
    const gone = {
      ...savedByWizard,
      tools_policy: { ...savedByWizard.tools_policy, old: { required_scopes: { oauth: ["x"] } } },
    };
    expect(check(gone)).toBe(false);
    // Cut list: the save keeps that entry, so it ships.
    expect(check(gone, false, true)).toBe(true);
  });

  it("warns on every other manifest change", () => {
    const changes: Record<string, unknown>[] = [
      { hidden_tools: ["fetch"] },
      { allow_undeclared_tools: true },
      { variables: { schema: { type: "object", properties: {} } } },
      { tools_policy: { search: { required_scopes: { oauth: ["write"] } }, fetch: {} } },
      { tools_policy: { ...savedByWizard.tools_policy, fetch: { description: "edited" } } },
      // An identity field already set is not the sync's to fill.
      { display_name: "Acme renamed" },
      { source: { kind: "remote", remote: { url: "https://b.test/mcp" } } },
      { auths: { oauth: { ...oauth, default_scopes: ["x"] } } },
    ];
    for (const change of changes) expect(check({ ...savedByWizard, ...change })).toBe(true);
  });

  it("warns on unarchived changes at mount the wizard did not save (files it cannot see)", () => {
    // The tools are not declared yet: no save of this step explains the changes.
    expect(check(published, true)).toBe(true);
    expect(check(published, false)).toBe(false);
  });
});

describe("catalogConnectionsKey", () => {
  const detail = (connections: { id: string; needs_reconnection: boolean }[]) => ({
    auths: [{ connections }],
  });

  it("changes when a connection is added or reconnected, not with their order", () => {
    const key = catalogConnectionsKey(detail([{ id: "a", needs_reconnection: true }]));
    expect(catalogConnectionsKey(detail([{ id: "a", needs_reconnection: false }]))).not.toBe(key);
    expect(
      catalogConnectionsKey(
        detail([
          { id: "a", needs_reconnection: true },
          { id: "b", needs_reconnection: false },
        ]),
      ),
    ).not.toBe(key);
    expect(
      catalogConnectionsKey(
        detail([
          { id: "b", needs_reconnection: false },
          { id: "a", needs_reconnection: true },
        ]),
      ),
    ).toBe(
      catalogConnectionsKey(
        detail([
          { id: "a", needs_reconnection: true },
          { id: "b", needs_reconnection: false },
        ]),
      ),
    );
  });
});

describe("toolsUpdateBody", () => {
  const sync = {
    manifest: { default_tools: ["read"], tools_policy: { read: {}, write: {}, purge: {} } },
    warnings: [],
  } as unknown as Pick<ServerSyncProposal, "manifest" | "warnings">;
  const draft = {
    name: "@org/acme",
    version: "1.0.0",
    source: proposal.source,
    auths: { oauth },
  };

  it("declares every tool, selects the chosen ones and bumps the version", () => {
    const body = toolsUpdateBody(draft, sync, {
      selected: ["read", "write"],
      version: "1.1.0",
      instructions: null,
    });
    expect(body).toEqual({
      manifest: {
        ...draft,
        tools_policy: { read: {}, write: {}, purge: {} },
        default_tools: ["read", "write"],
        version: "1.1.0",
      },
    });
  });

  it("keeps an authored tool policy and writes the accepted instructions as INTEGRATION.md", () => {
    const authored = { ...draft, tools_policy: { write: { required_scopes: { oauth: ["w"] } } } };
    const body = toolsUpdateBody(authored, sync, {
      selected: [],
      version: "1.1.0",
      instructions: "# Acme",
    });
    expect(body.manifest.tools_policy).toEqual({
      read: {},
      write: { required_scopes: { oauth: ["w"] } },
      purge: {},
    });
    expect(body.manifest.default_tools).toEqual([]);
    expect(body.operations).toEqual([{ op: "write", path: "INTEGRATION.md", text: "# Acme" }]);
  });
});

describe("toolsUpdateBody — truncated catalogue", () => {
  const draft = {
    name: "@org/acme",
    version: "1.0.0",
    source: proposal.source,
    tools_policy: { a: {}, b: {} },
    default_tools: ["a", "b"],
  };
  const partial = (truncated: boolean) =>
    ({
      manifest: { default_tools: [], tools_policy: { a: {} } },
      warnings: truncated ? [{ code: "tools_truncated", message: "…" }] : [],
    }) as unknown as Pick<ServerSyncProposal, "manifest" | "warnings">;
  const choice = { selected: ["a"], version: "1.1.0", instructions: null };

  it("keeps the selected tools the server did not list when the list was cut", () => {
    const body = toolsUpdateBody(draft, partial(true), choice);
    expect(body.manifest.tools_policy).toEqual({ a: {}, b: {} });
    expect(body.manifest.default_tools).toEqual(["b", "a"]);
    // Unchecking a listed tool still unselects it.
    expect(
      toolsUpdateBody(draft, partial(true), { ...choice, selected: [] }).manifest.default_tools,
    ).toEqual(["b"]);
  });

  it("keeps every unlisted tool a `*` selection held, and never adds an undeclared name", () => {
    const all = toolsUpdateBody({ ...draft, default_tools: "*" }, partial(true), choice);
    expect(all.manifest.default_tools).toEqual(["b", "a"]);
    const stray = toolsUpdateBody(
      { ...draft, default_tools: ["a", "b", "ghost"] },
      partial(true),
      choice,
    );
    expect(stray.manifest.default_tools).toEqual(["b", "a"]);
  });

  it("replaces the selection with the user's choice when the list is complete", () => {
    const body = toolsUpdateBody(draft, partial(false), choice);
    expect(body.manifest.tools_policy).toEqual({ a: {} });
    expect(body.manifest.default_tools).toEqual(["a"]);
  });
});

describe("toolsUpdateBody — INTEGRATION.md", () => {
  const sync = {
    manifest: { default_tools: [], tools_policy: { read: {} } },
    warnings: [],
  } as unknown as Pick<ServerSyncProposal, "manifest" | "warnings">;
  const draft = { name: "@org/acme", version: "1.0.0", source: proposal.source };

  it("deletes the file when asked, and sends no operation otherwise", () => {
    const base = { selected: [], version: "1.0.0", instructions: null };
    expect(toolsUpdateBody(draft, sync, { ...base, removeDocs: true }).operations).toEqual([
      { op: "delete", path: "INTEGRATION.md" },
    ]);
    expect(toolsUpdateBody(draft, sync, base)).not.toHaveProperty("operations");
  });
});

describe("docsChoice", () => {
  it("writes accepted instructions and remembers it", () => {
    expect(docsChoice({ include: true, instructions: "# Doc", written: false })).toEqual({
      instructions: "# Doc",
      removeDocs: false,
      written: true,
    });
  });

  it("deletes only the file this session wrote, once declined", () => {
    expect(docsChoice({ include: false, instructions: "# Doc", written: true })).toEqual({
      instructions: null,
      removeDocs: true,
      written: false,
    });
    expect(docsChoice({ include: false, instructions: "# Doc", written: false })).toEqual({
      instructions: null,
      removeDocs: false,
      written: false,
    });
  });

  it("touches nothing when the server proposes none (the draft already has its file)", () => {
    expect(docsChoice({ include: true, instructions: null, written: false })).toEqual({
      instructions: null,
      removeDocs: false,
      written: false,
    });
    expect(docsChoice({ include: true, instructions: null, written: true })).toEqual({
      instructions: null,
      removeDocs: false,
      written: true,
    });
  });
});

describe("initialToolSelection", () => {
  const listed = {
    manifest: { default_tools: ["read"], tools_policy: { read: {}, write: {} } },
    tools: [
      { name: "read", read_only: true },
      { name: "write", read_only: false },
    ],
  } as unknown as Pick<ServerSyncProposal, "manifest" | "tools">;

  it("starts from the server's read-only pre-selection while the draft declares no tool", () => {
    expect([...initialToolSelection({ name: "@org/acme" }, listed)]).toEqual(["read"]);
  });

  it("never pre-checks a destructive tool, even one also marked read-only", () => {
    const both = {
      manifest: { default_tools: ["read", "purge"], tools_policy: { read: {}, purge: {} } },
      tools: [
        { name: "read", read_only: true, destructive: false },
        { name: "purge", read_only: true, destructive: true },
      ],
    } as unknown as Pick<ServerSyncProposal, "manifest" | "tools">;
    expect([...initialToolSelection({ name: "@org/acme" }, both)]).toEqual(["read"]);
  });

  it("keeps a selection already saved in the draft, an explicit empty one included", () => {
    const declared = { tools_policy: { read: {}, write: {} } };
    expect([...initialToolSelection({ ...declared, default_tools: [] }, listed)]).toEqual([]);
    expect([
      ...initialToolSelection({ ...declared, default_tools: ["write", "gone"] }, listed),
    ]).toEqual(["write"]);
    expect([...initialToolSelection({ ...declared, default_tools: "*" }, listed)]).toEqual([
      "read",
      "write",
    ]);
  });
});

describe("defaultToolCount", () => {
  it("counts what an agent inherits", () => {
    const tools_policy = { a: {}, b: {} };
    expect(defaultToolCount({ tools_policy, default_tools: ["a"] })).toBe(1);
    expect(defaultToolCount({ tools_policy, default_tools: "*" })).toBe(2);
    expect(defaultToolCount({ tools_policy })).toBe(0);
  });
});

describe("needsWizardFinish", () => {
  const remote = { source: { kind: "remote", remote: { url: "https://mcp.acme.test/mcp" } } };
  const facts = { manifest: remote, homeWritable: true, canOpenWizard: true };

  it("offers to finish a writable remote integration with no tool, published or still a draft", () => {
    // The detail's manifest: the published version, else the draft.
    expect(needsWizardFinish(facts)).toBe(true);
  });

  it("stays quiet once tools are declared", () => {
    const manifest = { ...remote, tools_policy: { search: { description: "Search" } } };
    expect(needsWizardFinish({ ...facts, manifest })).toBe(false);
  });

  it("stays quiet for a local source or a read-only caller", () => {
    const local = { source: { kind: "local", server: { name: "x", version: "1.0.0" } } };
    expect(needsWizardFinish({ ...facts, manifest: local })).toBe(false);
    expect(needsWizardFinish({ ...facts, homeWritable: false })).toBe(false);
  });

  it("offers nothing to a writer of the home who cannot open the wizard in this space", () => {
    // Home A writable, viewed from space B where the caller only reads integrations.
    expect(needsWizardFinish({ ...facts, homeWritable: true, canOpenWizard: false })).toBe(false);
  });
});

describe("wizardResumePath", () => {
  it("encodes the package id", () => {
    expect(wizardResumePath("@org/acme")).toBe("/integrations/new/mcp?package=%40org%2Facme");
  });
});
