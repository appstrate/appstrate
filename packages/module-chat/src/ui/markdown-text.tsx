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
        // Open links in a new tab so clicking one (e.g. an OAuth auth_url the
        // model pasted despite guidance) never navigates the chat SPA away —
        // the conversation stays mounted and resumes on connection completion.
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    />
  );
}
