// SPDX-License-Identifier: Apache-2.0

import {
  defaultAgentManifest,
  defaultIntegrationManifest,
  defaultSkillManifest,
} from "../components/agent-editor/utils";
import { getSource, setSource } from "../components/integration-editor/utils";

export type NewPackageType = "agent" | "skill" | "integration";

/** What the creation dialog collects; `prompt` is an agent's, `url` an integration's remote MCP server. */
export interface NewPackageInput {
  scope: string | undefined;
  email: string | undefined;
  id: string;
  displayName: string; // canonical-casing-exempt: TS-internal dialog state; the manifest key is written as snake_case `display_name`.
  description: string;
  prompt: string;
  url: string;
}

/** A skill's `SKILL.md`: the frontmatter every write path requires, the description quoted so any text stays one YAML scalar. */
function newSkillContent(id: string, description: string): string {
  return `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\n---\n`;
}

/** The `POST /api/packages/{type}s` body of a package created from the dialog; everything else is edited on the saved package. */
export function newPackageBody(type: NewPackageType, input: NewPackageInput) {
  const identity = {
    name: `@${input.scope}/${input.id}`,
    display_name: input.displayName.trim(),
    description: input.description.trim(),
  };
  switch (type) {
    case "agent":
      return {
        manifest: { ...defaultAgentManifest(input.scope, input.email), ...identity },
        content: input.prompt,
      };
    case "skill":
      return {
        manifest: { ...defaultSkillManifest(input.scope, input.email), ...identity },
        content: newSkillContent(input.id, identity.description),
      };
    case "integration": {
      const base = { ...defaultIntegrationManifest(input.scope, input.email), ...identity };
      const manifest = setSource(base, { ...getSource(base), remoteUrl: input.url.trim() });
      return { manifest, content: JSON.stringify(manifest, null, 2) };
    }
  }
}
