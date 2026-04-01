import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { JsonView as JsonViewLite, allExpanded, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface JsonViewProps {
  data: unknown;
}

// Use structural classes from the lib (layout, spacing, icons) but override all
// color classes with Tailwind tokens so the viewer adapts to light/dark theme.
const jsonStyles = {
  ...defaultStyles,
  container: `${defaultStyles.container} !bg-transparent`,
  label: `${defaultStyles.label} !text-foreground font-medium`,
  clickableLabel: `${defaultStyles.clickableLabel} !text-foreground font-medium`,
  stringValue: `${defaultStyles.stringValue} !text-success`,
  numberValue: `${defaultStyles.numberValue} !text-primary`,
  booleanValue: `${defaultStyles.booleanValue} !text-primary`,
  nullValue: `${defaultStyles.nullValue} !text-muted-foreground`,
  undefinedValue: `${defaultStyles.undefinedValue} !text-muted-foreground`,
  otherValue: `${defaultStyles.otherValue} !text-muted-foreground`,
  punctuation: `${defaultStyles.punctuation} !text-muted-foreground`,
  collapseIcon: `${defaultStyles.collapseIcon} !text-muted-foreground`,
  expandIcon: `${defaultStyles.expandIcon} !text-muted-foreground`,
  collapsedContent: `${defaultStyles.collapsedContent} !text-muted-foreground`,
  noQuotesForStringValues: false,
  quotesForFieldNames: true,
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("text-muted-foreground h-7 w-7", copied && "text-success")}
      onClick={handleCopy}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </Button>
  );
}

export function JsonView({ data }: JsonViewProps) {
  const jsonString = useMemo(() => JSON.stringify(data, null, 2), [data]);

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10">
        <CopyButton text={jsonString} />
      </div>
      <div className="max-h-[500px] overflow-auto font-mono text-sm">
        <JsonViewLite
          data={data as Record<string, unknown>}
          shouldExpandNode={allExpanded}
          style={jsonStyles}
          clickToExpandNode
        />
      </div>
    </div>
  );
}
