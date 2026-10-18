// SPDX-License-Identifier: Apache-2.0

import { setResourceEntries } from "../components/agent-editor/utils";
import type { EditorState } from "../hooks/use-editor-state";
import { packageCreateBody } from "./package-file-drafts";

/**
 * The body that creates an agent from what the creation modal asks. `integrationId` adds that
 * integration as a dependency with no tool selection, so the agent inherits its default tools
 * (what the agent editor does when an integration is added). `base` is left untouched.
 */
export function newAgentCreateBody(input: {
  base: EditorState;
  orgSlug: string | undefined;
  slug: string;
  displayName: string;
  description: string;
  prompt: string;
  integrationId?: string;
}) {
  const manifest = {
    ...structuredClone(input.base.manifest),
    name: `@${input.orgSlug}/${input.slug}`,
    display_name: input.displayName.trim(),
    description: input.description.trim(),
  };
  if (input.integrationId) {
    setResourceEntries(manifest, "integrations", [{ id: input.integrationId, version: "*" }]);
  }
  return packageCreateBody(
    { manifest, operations: [{ op: "write", path: "prompt.md", text: input.prompt }] },
    "agent",
  );
}
