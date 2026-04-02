/**
 * Minimal Appstrate skill extension for the Pi Coding Agent SDK.
 *
 * This file exports an extension factory that registers a "word_count" tool.
 * The agent can call this tool during agent runs.
 *
 * Extension import: @mariozechner/pi-coding-agent (NOT "pi-agent")
 * Execute signature: (_toolCallId, params, signal) -- params is the SECOND argument
 * Return type: { content: [{ type: "text", text: "..." }] }
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

const wordCountExtension: ExtensionFactory = (context) => {
  return {
    name: "word_count",
    tools: [
      {
        name: "word_count",
        description:
          "Count the number of words in a given text. Returns the word count as a formatted string.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to count words in",
            },
          },
          required: ["text"],
        },
        execute: async (_toolCallId, params, _signal) => {
          const { text } = params as { text: string };
          const words = text.trim().split(/\s+/).filter(Boolean);
          const count = words.length;

          return {
            content: [
              {
                type: "text" as const,
                text: `The text contains ${count} word${count === 1 ? "" : "s"}.`,
              },
            ],
          };
        },
      },
    ],
  };
};

export default wordCountExtension;
