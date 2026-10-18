// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { defaultEditorState } from "../../components/agent-editor/utils";
import { newAgentCreateBody } from "../agent-creation.ts";

const input = {
  orgSlug: "acme",
  slug: "digest",
  displayName: " Digest ",
  description: " Daily ",
  prompt: "Do it",
};

describe("newAgentCreateBody", () => {
  it("declares no integration unless one is given", () => {
    const body = newAgentCreateBody({ ...input, base: defaultEditorState("acme", "a@b.c") });
    expect(body.manifest).toMatchObject({
      name: "@acme/digest",
      display_name: "Digest",
      description: "Daily",
      dependencies: {},
    });
    expect(JSON.stringify(body.manifest)).not.toContain("integrations");
  });

  it("adds the integration at any version, with no tool selection", () => {
    const base = defaultEditorState("acme", "a@b.c");
    const body = newAgentCreateBody({ ...input, base, integrationId: "@appstrate/gmail" });
    const manifest = body.manifest as { dependencies: Record<string, unknown> };
    expect(manifest.dependencies.integrations).toEqual({ "@appstrate/gmail": "*" });
    expect(JSON.stringify(body.manifest)).not.toContain("integrations_configuration");
    expect(base.manifest.dependencies).toEqual({});
  });
});
