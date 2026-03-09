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

const inlineComponents: Components = {
  ...components,
  p: ({ children }) => <span>{children}</span>,
};

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function InlineMarkdown({ children, className }: MarkdownProps) {
  return (
    <span className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={inlineComponents}>
        {children}
      </ReactMarkdown>
    </span>
  );
}
