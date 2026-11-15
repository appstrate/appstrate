// SPDX-License-Identifier: Apache-2.0

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

const remarkPlugins = [remarkGfm, remarkBreaks];

const components: Components = {
  a: ({ href, children, ...props }) => {
    const isExternal = href?.startsWith("http");
    return (
      <a
        href={href}
        {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        {...props}
      >
        {children}
      </a>
    );
  },
};

interface MarkdownProps {
  children: string;
  className?: string;
  inert?: boolean;
}

const previewElements = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "hr",
  "br",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

export function Markdown({ children, className, inert = false }: MarkdownProps) {
  return (
    <div className={`prose prose-sm max-w-none ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={components}
        allowedElements={inert ? previewElements : undefined}
        unwrapDisallowed={inert}
        skipHtml={inert}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
