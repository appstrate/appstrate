// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { defaultIntegrationManifest } from "../../components/agent-editor/utils.ts";
import { stableJson } from "../stable-json";
import {
  connectBlocker,
  integrationCreationManifest,
  integrationWizardStep,
  isRemoteSource,
  needsWizardFinish,
  docsChoice,
  toolsPublishBody,
  toolsPublishVersion,
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

  it("drops the default API key auth for a proposal declaring none (AFPS §7.2)", () => {
    const { auths: _auths, ...open } = proposal;
    const manifest = integrationCreationManifest(defaults, open, open);
    expect(manifest).not.toHaveProperty("auths");
    expect(manifest.source).toEqual(proposal.source);
  });

  it("carries the icon, the proposal's or the re-encoded one", () => {
    const withIcon = { ...proposal, icon: "data:image/png;base64,AAA" };
    expect(integrationCreationManifest(defaults, withIcon, withIcon).icon).toBe(
      "data:image/png;base64,AAA",
    );
    expect(integrationCreationManifest(defaults, proposal, proposal, "data:x").icon).toBe("data:x");
  });

  it("is created by the wizard as a draft only, the manifest sent once", () => {
    const manifest = integrationCreationManifest(defaults, proposal, proposal);
    expect(wizardCreateBody(manifest, "guided")).toEqual({ manifest, publish: false });
    expect(wizardCreateBody(manifest, "guided").manifest.version).toBe("1.0.0");
  });

  it("is created the manual way as the creation dialog creates it, published by the gate", () => {
    const manifest = integrationCreationManifest(defaults, proposal, proposal);
    expect(wizardCreateBody(manifest, "manual")).toEqual({ manifest });
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
      connected: true,
    };
    expect(integrationWizardStep({ ...facts, remote: false })).toBe("notRemote");
    expect(integrationWizardStep({ ...facts, connection: "none" })).toBe("connect");
    expect(integrationWizardStep(facts)).toBe("ready");
    // Declared tools play no part: ready is a published version.
    expect(integrationWizardStep({ ...facts, published: false })).toBe("tools");
  });

  it("goes from connecting to the tools on a draft never published", () => {
    const draft = {
      remote: true,
      active: true,
      published: false,
      connection: "none" as const,
      connected: true,
    };
    expect(integrationWizardStep(draft)).toBe("connect");
    expect(integrationWizardStep({ ...draft, connection: "ready" })).toBe("tools");
  });

  it("is not ready while no usable connection exists", () => {
    const facts = {
      remote: true,
      active: true,
      published: true,
      connection: "none" as const,
      connected: true,
    };
    expect(integrationWizardStep(facts)).toBe("connect");
  });
});

describe("integrationWizardStep — never published", () => {
  const facts = {
    remote: true,
    active: true,
    published: false,
    connection: "not_published" as const,
    connected: false,
  };

  it("reads whether an account exists, since the verdict hides it", () => {
    expect(integrationWizardStep(facts)).toBe("connect");
    expect(integrationWizardStep({ ...facts, connected: true })).toBe("tools");
  });

  it("offers to connect, with no blocker", () => {
    expect(connectBlocker({ status: "not_published", imposed: false })).toEqual({
      blocker: "none",
      offerConnect: true,
    });
  });
});

describe("integrationWizardStep — governed connection", () => {
  const facts = {
    remote: true,
    active: true,
    published: true,
    connection: "ready" as const,
    connected: true,
  };

  it("proceeds on the proxy's verdict alone: ready, or a choice the tools step asks for", () => {
    expect(integrationWizardStep(facts)).toBe("ready");
    expect(integrationWizardStep({ ...facts, connection: "must_choose" })).toBe("ready");
  });

  it("skips the connect step of an integration declaring no auths (AFPS §7.2)", () => {
    expect(integrationWizardStep({ ...facts, connection: "not_required" })).toBe("ready");
  });

  it("stays at the connect step on every verdict a call would be refused with", () => {
    for (const connection of [
      "none",
      "needs_reconnection",
      "not_permitted",
      "default_unavailable",
      "unusable",
      "proxy_closed",
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

  it("offers no connection in a space that closes the credential proxy, imposed or not", () => {
    for (const imposed of [false, true]) {
      expect(connectBlocker({ status: "proxy_closed", imposed })).toEqual({
        blocker: "proxyClosed",
        offerConnect: false,
      });
    }
  });
});

describe("integrationWizardStep — activation", () => {
  it("is never ready, nor at a later step, while switched off in this space", () => {
    const ready = {
      remote: true,
      active: false,
      published: true,
      connection: "ready" as const,
      connected: true,
    };
    expect(integrationWizardStep(ready)).toBe("inactive");
    expect(integrationWizardStep({ ...ready, connection: "none" })).toBe("inactive");
    expect(integrationWizardStep({ ...ready, remote: false })).toBe("notRemote");
    expect(integrationWizardStep({ ...ready, active: true })).toBe("ready");
  });
});

describe("isRemoteSource", () => {
  it("handles only a remote MCP source", () => {
    expect(isRemoteSource({ source: proposal.source })).toBe(true);
    expect(
      isRemoteSource({
        source: {
          kind: "local",
          server: { type: "node", entry_point: "server/index.js", mcp_config: { command: "node" } },
        },
      }),
    ).toBe(false);
    expect(isRemoteSource({ source: { kind: "none" } })).toBe(false);
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

describe("toolsPublishBody", () => {
  const draft = { name: "@org/acme", version: "1.0.0", tools_policy: { kept: {} } };

  it("declares nothing by default: no tool, no default selection, no wildcard", () => {
    const { manifest } = toolsPublishBody(draft, { trustAll: false, version: "1.0.0" });
    expect(manifest).toEqual(draft);
    expect(manifest).not.toHaveProperty("allow_undeclared_tools");
    expect(manifest).not.toHaveProperty("default_tools");
  });

  it("trusting every tool sets the wildcard and the version, and nothing else", () => {
    const { manifest } = toolsPublishBody(draft, { trustAll: true, version: "1.1.0" });
    expect(manifest).toEqual({ ...draft, version: "1.1.0", allow_undeclared_tools: true });
  });

  it("takes back a wildcard an earlier save wrote", () => {
    const { manifest } = toolsPublishBody(
      { ...draft, allow_undeclared_tools: true },
      { trustAll: false, version: "1.0.0" },
    );
    expect(manifest).not.toHaveProperty("allow_undeclared_tools");
  });

  it("writes no file unless the server's instructions are kept", () => {
    expect(toolsPublishBody(draft, { trustAll: true, version: "1.1.0" })).not.toHaveProperty(
      "operations",
    );
    const body = toolsPublishBody(draft, {
      trustAll: false,
      version: "1.0.0",
      instructions: "# Acme",
    });
    expect(body.operations).toEqual([{ op: "write", path: "INTEGRATION.md", text: "# Acme" }]);
    expect(
      toolsPublishBody(draft, { trustAll: false, version: "1.0.0", removeDocs: true }).operations,
    ).toEqual([{ op: "delete", path: "INTEGRATION.md" }]);
  });

  it("fills only the identity the draft left empty, and never tools", () => {
    const { manifest } = toolsPublishBody(
      { ...draft, display_name: "Mine", description: "" },
      {
        trustAll: false,
        version: "1.0.0",
        proposed: { display_name: "Server", description: "From server", tools_policy: { x: {} } },
      },
    );
    expect(manifest.display_name).toBe("Mine");
    expect(manifest.description).toBe("From server");
    expect(manifest.tools_policy).toEqual({ kept: {} });
  });
});

describe("docsChoice", () => {
  it("writes the instructions while included", () => {
    expect(docsChoice({ include: true, instructions: "# Doc", written: false })).toEqual({
      instructions: "# Doc",
      removeDocs: false,
      written: true,
    });
  });

  it("deletes the file only when this session wrote it and the user declined it since", () => {
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

  it("touches nothing when the server sent no instructions", () => {
    expect(docsChoice({ include: true, instructions: null, written: false })).toEqual({
      instructions: null,
      removeDocs: false,
      written: false,
    });
  });
});

describe("needsWizardFinish", () => {
  const remote = { source: { kind: "remote", remote: { url: "https://mcp.acme.test/mcp" } } };
  const facts = { manifest: remote, published: false, homeWritable: true, canOpenWizard: true };

  it("offers to finish a writable remote integration still unpublished", () => {
    expect(needsWizardFinish(facts)).toBe(true);
  });

  it("stays quiet once a version is published, whatever tools it declares", () => {
    expect(needsWizardFinish({ ...facts, published: true })).toBe(false);
  });

  it("stays quiet for a local source or a read-only caller", () => {
    const local = {
      source: {
        kind: "local",
        server: { type: "node", entry_point: "server/index.js", mcp_config: { command: "node" } },
      },
    };
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

describe("settings and wizard JSON comparisons", () => {
  it("ignores missing JSON values in objects and preserves array order", () => {
    expect(stableJson({ b: undefined, a: { c: 3, a: 2 } })).toBe(stableJson({ a: { a: 2, c: 3 } }));
    expect(stableJson([undefined, 2])).toBe(stableJson([null, 2]));
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
    expect(stableJson(undefined)).toBeUndefined();
    expect(() => stableJson(2n)).toThrow();
  });
});
