/** Search the web using DuckDuckGo and return results */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using DuckDuckGo and return results as text.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results to return (default: 5)", default: 5 })),
    }),
    async execute(_toolCallId, params, signal) {
      const query = encodeURIComponent(params.query);
      const url = `https://html.duckduckgo.com/html/?q=${query}`;

      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Appstrate/1.0)",
        },
        signal,
      });

      const html = await res.text();
      const maxResults = params.maxResults || 5;

      // Parse results from DuckDuckGo HTML
      const results: { title: string; url: string; snippet: string }[] = [];
      const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

      let match;
      while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
        const resultUrl = match[1] || "";
        const title = (match[2] || "").replace(/<[^>]*>/g, "").trim();

        const snippetMatch = snippetPattern.exec(html);
        const snippet = snippetMatch
          ? (snippetMatch[1] || "").replace(/<[^>]*>/g, "").trim()
          : "";

        if (title && resultUrl) {
          // DuckDuckGo uses redirect URLs, extract actual URL
          const actualUrl = decodeURIComponent(
            resultUrl.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0] || resultUrl,
          );
          results.push({ title, url: actualUrl, snippet });
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found for: ${params.query}` }],
        };
      }

      const text = results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: `Search results for "${params.query}":\n\n${text}` }],
      };
    },
  });
}
