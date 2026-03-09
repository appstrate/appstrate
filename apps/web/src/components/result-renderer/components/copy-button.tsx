import { useState, useRef, useCallback, useEffect } from "react";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const { t } = useTranslation("flows");
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
      className={cn("h-7 w-7 text-muted-foreground", copied && "text-success", className)}
      onClick={handleCopy}
      title={copied ? t("result.copied") : t("result.copyAll")}
    >
      <span aria-live="polite" className="sr-only">
        {copied ? t("result.copied") : ""}
      </span>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </Button>
  );
}
