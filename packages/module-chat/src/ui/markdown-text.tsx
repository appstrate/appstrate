// SPDX-License-Identifier: Apache-2.0

/** Streaming-aware markdown renderer for assistant messages (GFM + prose). */

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="prose prose-sm dark:prose-invert max-w-none break-words [&_code]:text-[0.85em] [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:text-xs"
      components={{
        a: ({ node: _node, href, children, ...props }) => {
          // Suppress integration OAuth authorize links the model pastes despite
          // guidance: the native connect card already handles the flow, and a
          // raw auth link is a dead-end (full-tab callback, no resume). Detected
          // by our callback path in its redirect_uri — generic across providers,
          // independent of model compliance. Render the label as inert muted
          // text pointing at the card instead of a clickable link.
          if (href && /integrations(%2f|\/)callback/i.test(href)) {
            return (
              <span className="text-muted-foreground italic">
                {children}{" "}
                <span className="text-xs">(utilise le bouton de connexion ci‑dessus)</span>
              </span>
            );
          }
          // Open other links in a new tab so a click never navigates the chat
          // SPA away — the conversation stays mounted.
          return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
        },
      }}
    />
  );
}
