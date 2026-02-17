/** Fetch content from a URL and return it as text */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Fetch URL",
    description: "Fetch content from a URL and return it as text. Useful for reading web pages, APIs, or downloading data.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default: GET)", default: "GET" })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "HTTP headers" })),
      body: Type.Optional(Type.String({ description: "Request body (for POST/PUT)" })),
    }),
    async execute(_toolCallId, params, signal) {
      const res = await fetch(params.url, {
        method: params.method || "GET",
        headers: params.headers,
        body: params.body,
        signal,
      });

      const text = await res.text();
      const truncated = text.slice(0, 50000);
      const wasTruncated = text.length > 50000;

      return {
        content: [
          {
            type: "text" as const,
            text: `Status: ${res.status}\n\n${truncated}${wasTruncated ? "\n\n[Content truncated at 50000 characters]" : ""}`,
          },
        ],
      };
    },
  });
}
