// SPDX-License-Identifier: Apache-2.0

import { defaultEditorState, defaultSkillManifest } from "../components/agent-editor/utils";
import { packageCreateBody } from "./package-file-drafts";

/** Companion files and wire payload are produced once, from the creation form's values. */
export function createPackageBody({
  type,
  scope,
  author,
  slug,
  name,
  description,
  content,
  integration,
}: {
  type: "agent" | "skill" | "integration";
  scope: string;
  author?: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  integration?: Record<string, unknown>;
}) {
  const manifest = {
    ...(type === "agent"
      ? defaultEditorState(scope, author).manifest
      : type === "skill"
        ? defaultSkillManifest(scope, author)
        : integration),
    name: `@${scope}/${slug}`,
    display_name: name.trim(),
    description: description.trim(),
    author: author ?? "",
  };
  return packageCreateBody(
    {
      manifest,
      operations:
        type === "integration"
          ? []
          : [
              {
                op: "write",
                path: type === "agent" ? "prompt.md" : "SKILL.md",
                text:
                  type === "agent"
                    ? content
                    : `---\nname: ${slug}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${content}`,
              },
            ],
    },
    type,
  );
}
