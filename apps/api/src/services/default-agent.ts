// SPDX-License-Identifier: Apache-2.0

import { inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import { caretRange } from "@appstrate/core/semver";
import { createOrgItem } from "./package-items/crud.ts";
import { CONFIG_BY_TYPE } from "./package-items/config.ts";
import { installPackage } from "./application-packages.ts";
import { logger } from "../lib/logger.ts";
import { asRecord } from "../lib/safe-json.ts";

const HELLO_WORLD_MANIFEST = {
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello World",
  author: "Appstrate",
  description: "Un agent de démonstration pour découvrir les capacités de la plateforme Appstrate.",
  keywords: ["demo", "example", "getting-started"],
};

const HELLO_WORLD_TOOL_DEPS = ["@appstrate/report"] as const;

const HELLO_WORLD_PROMPT = `# Hello World

Welcome to Appstrate! You are an AI agent running inside an ephemeral Docker container.

## Your mission

1. **Introduce yourself**: Briefly explain what you are — an autonomous AI agent executing in an isolated, secure environment.

2. **Showcase platform capabilities**:
   - Connect to external services (Gmail, ClickUp, Google Sheets, etc.) to read and write data
   - Execute complex automated tasks autonomously
   - Produce structured, actionable results

3. **Encourage the user** to create their own agents to automate their daily tasks.

Be concise, enthusiastic, and professional.
`;

/**
 * Resolve each tool dependency ID to its canonical caret range from the
 * registry. Skips IDs whose package row is missing or whose draft
 * manifest carries no version — better to provision the demo agent
 * without the dep than to persist an unresolvable wildcard.
 */
async function resolveToolDeps(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, ids));
  const result: Record<string, string> = {};
  for (const row of rows) {
    const version = asRecord(row.draftManifest).version;
    if (typeof version === "string") {
      result[row.id] = caretRange(version);
    }
  }
  return result;
}

/**
 * Provision a default "Hello World" agent for a newly created organization.
 * Non-fatal: logs a warning on failure (e.g. if the agent already exists).
 */
export async function provisionDefaultAgentForOrg(
  orgId: string,
  orgSlug: string,
  createdBy: string,
  defaultAppId: string,
): Promise<void> {
  try {
    const packageId = `@${orgSlug}/hello-world`;

    const toolDeps = await resolveToolDeps([...HELLO_WORLD_TOOL_DEPS]);
    const manifest = {
      ...HELLO_WORLD_MANIFEST,
      name: packageId,
      ...(Object.keys(toolDeps).length > 0
        ? { dependencies: { tools: toolDeps } }
        : { dependencies: {} }),
    };

    await createOrgItem(
      orgId,
      {
        id: packageId,
        name: "Hello World",
        description: HELLO_WORLD_MANIFEST.description,
        content: HELLO_WORLD_PROMPT,
        createdBy,
      },
      CONFIG_BY_TYPE.agent,
      manifest,
    );

    // Install in the default app so it's visible immediately
    await installPackage({ orgId, applicationId: defaultAppId }, packageId).catch((e: unknown) =>
      logger.warn("Failed to auto-install hello-world in default app", {
        packageId,
        defaultAppId,
        err: String(e),
      }),
    );

    logger.info("Provisioned default hello-world agent", { orgId, packageId });
  } catch (err) {
    logger.warn("Failed to provision default hello-world agent (may already exist)", {
      orgId,
      err,
    });
  }
}
