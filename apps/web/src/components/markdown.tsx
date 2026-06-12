// SPDX-License-Identifier: Apache-2.0

import { lazy, Suspense } from "react";

/**
 * Lazy boundary around the react-markdown/micromark stack (markdown-impl.tsx).
 * Markdown only renders on run result/report surfaces, so the parser is
 * fetched on demand instead of shipping in the entry chunk. While the chunk
 * loads we render the raw text — same content, unformatted — to avoid any
 * layout flash.
 */
const MarkdownImpl = lazy(() => import("./markdown-impl").then((m) => ({ default: m.Markdown })));
const InlineMarkdownImpl = lazy(() =>
  import("./markdown-impl").then((m) => ({ default: m.InlineMarkdown })),
);

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <Suspense
      fallback={
        <div className={`prose prose-sm max-w-none ${className ?? ""}`}>
          <p>{children}</p>
        </div>
      }
    >
      <MarkdownImpl className={className}>{children}</MarkdownImpl>
    </Suspense>
  );
}

export function InlineMarkdown({ children, className }: MarkdownProps) {
  return (
    <Suspense fallback={<span className={className}>{children}</span>}>
      <InlineMarkdownImpl className={className}>{children}</InlineMarkdownImpl>
    </Suspense>
  );
}
