import { type ReactNode, forwardRef } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleSectionProps {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  count?: number;
}

export const CollapsibleSection = forwardRef<HTMLDetailsElement, CollapsibleSectionProps>(
  function CollapsibleSection({ title, children, defaultOpen = true, className, count }, ref) {
    return (
      <details ref={ref} open={defaultOpen} className={cn("group mt-3", className)}>
        <summary className="flex cursor-pointer items-center gap-1.5 select-none list-none text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={14}
            className="text-muted-foreground transition-transform group-open:rotate-90"
          />
          <span>{title}</span>
          {count !== undefined && <span className="text-xs text-muted-foreground">({count})</span>}
        </summary>
        <div className="mt-1.5">{children}</div>
      </details>
    );
  },
);
