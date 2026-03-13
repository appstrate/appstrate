import { createOrgItem } from "./package-items/crud.ts";
import { FLOW_CONFIG } from "./package-items/config.ts";
import { logger } from "../lib/logger.ts";

const HELLO_WORLD_MANIFEST = {
  version: "1.0.0",
  type: "flow",
  schemaVersion: "1.0.0",
  displayName: "Hello World",
  author: "Appstrate",
  description: "Un flow de démonstration pour découvrir les capacités de la plateforme Appstrate.",
  tags: ["demo", "hello-world", "getting-started"],
};

const HELLO_WORLD_PROMPT = `# Hello World

Welcome to Appstrate! You are an AI agent running inside an ephemeral Docker container.

## Your mission

1. **Introduce yourself**: Briefly explain what you are — an autonomous AI agent executing in an isolated, secure environment.

2. **Showcase platform capabilities**:
   - Connect to external services (Gmail, ClickUp, Google Sheets, etc.) to read and write data
   - Execute complex automated tasks autonomously
   - Produce structured, actionable results

3. **Generate a structured result** as JSON with the following fields:
   - \`message\`: a personalized welcome message
   - \`timestamp\`: the current date and time
   - \`capabilities\`: a list of task types you can accomplish
   - \`status\`: "ready"

4. **Encourage the user** to create their own flows to automate their daily tasks.

Be concise, enthusiastic, and professional.
`;

/**
 * Provision a default "Hello World" flow for a newly created organization.
 * Non-fatal: logs a warning on failure (e.g. if the flow already exists).
 */
export async function provisionDefaultFlowForOrg(
  orgId: string,
  orgSlug: string,
  createdBy: string,
): Promise<void> {
  try {
    const packageId = `@${orgSlug}/hello-world`;

    await createOrgItem(
      orgId,
      orgSlug,
      {
        id: "hello-world",
        name: "Hello World",
        description: HELLO_WORLD_MANIFEST.description,
        content: HELLO_WORLD_PROMPT,
        createdBy,
      },
      FLOW_CONFIG,
      { ...HELLO_WORLD_MANIFEST, name: packageId },
    );

    logger.info("Provisioned default hello-world flow", { orgId, packageId });
  } catch (err) {
    logger.warn("Failed to provision default hello-world flow (may already exist)", {
      orgId,
      err,
    });
  }
}
