// SPDX-License-Identifier: Apache-2.0

import { createOrgItem } from "./package-items/crud.ts";
import { AGENT_CONFIG } from "./package-items/config.ts";
import { installPackage } from "./application-packages.ts";
import { logger } from "../lib/logger.ts";

const HELLO_WORLD_MANIFEST = {
  version: "1.0.0",
  type: "agent",
  schemaVersion: "1.1",
  displayName: "Hello World",
  author: "Appstrate",
  description: "Un agent de démonstration pour découvrir les capacités de la plateforme Appstrate.",
  keywords: ["demo", "example", "getting-started"],
  dependencies: {
    tools: {
      "@appstrate/report": "*",
    },
  },
};

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

    const manifest = { ...HELLO_WORLD_MANIFEST, name: packageId };

    await createOrgItem(
      orgId,
      {
        id: packageId,
        name: "Hello World",
        description: HELLO_WORLD_MANIFEST.description,
        content: HELLO_WORLD_PROMPT,
        createdBy,
      },
      AGENT_CONFIG,
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
