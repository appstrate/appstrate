// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { defaultIntegrationManifest } from "../../components/agent-editor/utils.ts";
import { packageCreateBody } from "../package-file-drafts.ts";
import type { ServerSyncProposal } from "../integration-server-sync.ts";
import {
  defaultToolCount,
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
    const facts = { remote: true, published: true, connected: true, toolsDeclared: false };
    expect(integrationWizardStep({ ...facts, remote: false })).toBe("notRemote");
    expect(integrationWizardStep({ ...facts, connected: false })).toBe("connect");
    expect(integrationWizardStep(facts)).toBe("tools");
    expect(integrationWizardStep({ ...facts, toolsDeclared: true })).toBe("ready");
  });

  it("goes from connecting to the tools on a draft never published", () => {
    const draft = { remote: true, published: false, connected: false, toolsDeclared: false };
    expect(integrationWizardStep(draft)).toBe("connect");
    expect(integrationWizardStep({ ...draft, connected: true })).toBe("tools");
    // A draft that declares tools (saved, its publish failed) is not ready: nothing is published.
    expect(integrationWizardStep({ ...draft, connected: true, toolsDeclared: true })).toBe("tools");
  });

  it("is not ready while no usable connection exists, tools declared or not", () => {
    const facts = { remote: true, published: true, connected: false, toolsDeclared: true };
    expect(integrationWizardStep(facts)).toBe("connect");
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
    const base = { published: true, draftVersion: "9.9.9" };
    expect(toolsPublishVersion({ ...base, publishedVersion: "1.0.0" })).toBe("1.1.0");
    expect(toolsPublishVersion({ ...base, publishedVersion: "2.3.4" })).toBe("2.4.0");
    expect(toolsPublishVersion({ ...base, publishedVersion: undefined })).toBeNull();
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
  const facts = { manifest: remote, writable: true };

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
    expect(needsWizardFinish({ ...facts, writable: false })).toBe(false);
  });
});

describe("wizardResumePath", () => {
  it("encodes the package id", () => {
    expect(wizardResumePath("@org/acme")).toBe("/integrations/new/mcp?package=%40org%2Facme");
  });
});
