// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { integrationManifestSchema } from "@appstrate/core/validation";
import { createPackageBody } from "../create-package";
import { defaultIntegrationManifest } from "../../components/agent-editor/utils";
import { setSource } from "../../components/integration-editor/utils";

const identity = {
  scope: "acme",
  slug: "review",
  name: " Review ",
  description: 'Describe: "this"\nnext line',
  author: "test@example.com",
  content: "Read the file, then review it.",
};

describe("createPackageBody", () => {
  it("sends an agent's prompt once and keeps its package identity", () => {
    const body = createPackageBody({ ...identity, type: "agent" });
    expect(body.content).toBe(identity.content);
    expect(body.manifest).toMatchObject({
      type: "agent",
      name: "@acme/review",
      display_name: "Review",
      author: identity.author,
    });
    expect(body).not.toHaveProperty("operations");
  });

  it("builds valid skill frontmatter from the bare slug and safely quotes the description", () => {
    const body = createPackageBody({ ...identity, type: "skill" });
    expect(checkSkillMarkdown(body.content)).toBeNull();
    expect(body.content).toStartWith("---\nname: review\n");
    expect(body.content).toEndWith(identity.content);
    expect(body.manifest.name).toBe("@acme/review");
    expect(body).not.toHaveProperty("operations");
  });

  it("creates a remote integration with credential injection bounded to its source host", () => {
    const integration = setSource(defaultIntegrationManifest("acme", identity.author), {
      kind: "remote",
      remoteUrl: "https://example.com/mcp",
      remoteTransport: "streamable-http",
      serverName: "",
      serverVersion: "",
    });
    const body = createPackageBody({ ...identity, type: "integration", integration });
    expect(integrationManifestSchema.safeParse(body.manifest).success).toBe(true);
    expect(JSON.parse(body.content)).toEqual(body.manifest);
    expect(body.manifest).toHaveProperty("auths.primary.authorized_uris", [
      "https://example.com/**",
    ]);
    expect(body).not.toHaveProperty("operations");
  });

  it("keeps the integration's explicitly configured authentication and source", () => {
    const integration = {
      ...defaultIntegrationManifest("acme"),
      source: { kind: "none" },
      auths: { token: { type: "none", authorized_uris: ["https://example.com/**"] } },
    };
    const body = createPackageBody({ ...identity, type: "integration", integration });
    expect(body.manifest).toMatchObject({ source: integration.source, auths: integration.auths });
  });
});
