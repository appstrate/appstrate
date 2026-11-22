// SPDX-License-Identifier: Apache-2.0

/**
 * An agent launch requested from the composer's `/` menu, as a part of the user message.
 *
 * The browser sends `{ name, title }`: the name of a prompt the platform MCP server serves
 * (`prompts/list`, `run-<agent>`) and its title, for the message's own display. The turn
 * resolves it with `prompts/get` before persisting the message and writes the launch
 * instructions it returns into `text`: the model is shown `text`, the thread shows `title`, and
 * a later turn replays the stored `text` rather than asking the server again.
 */

import { z } from "zod";

export const AGENT_PROMPT_PART_TYPE = "data-agent-prompt";

export const agentPromptDataSchema = z.strictObject({
  name: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  /** Written by the turn that resolves it; absent on what the browser sends. */
  text: z.string().optional(),
});
