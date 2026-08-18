// SPDX-License-Identifier: Apache-2.0

import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";

/**
 * Read-only value with a copy button.
 *
 * Used wherever the product asks someone to reproduce a string exactly
 * somewhere else — an MCP endpoint pasted into a client config, the OAuth
 * redirect URI registered at a provider. A value that must match
 * byte-for-byte is a value that must be copyable, never retyped.
 *
 * `select-all` keeps the whole string one click away when the clipboard API is
 * unavailable: `navigator.clipboard` is undefined outside a secure context, so
 * a plain-HTTP deployment gets no copy button behaviour at all.
 */
export function CopyBlock({
  value,
  multiline = false,
  dense = false,
  testId,
}: {
  value: string;
  /** Preserve newlines and scroll horizontally instead of wrapping. */
  multiline?: boolean;
  /** Tighter padding for inline use inside a form. */
  dense?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation("common");
  const { copied, copy } = useCopyToClipboard();
  return (
    <div
      className="border-border bg-muted/50 relative rounded-md border"
      {...(testId ? { "data-testid": testId } : {})}
    >
      <code
        className={`text-foreground block font-mono text-xs select-all ${
          dense ? "px-2 py-1.5 pr-9" : "px-3 py-2 pr-12"
        } ${multiline ? "overflow-x-auto whitespace-pre" : "break-all"}`}
      >
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={`text-muted-foreground hover:text-foreground absolute ${
          dense ? "top-0.5 right-0.5 h-6 w-6" : "top-1 right-1 h-7 w-7"
        }`}
        aria-label={t("btn.copy")}
        onClick={() => copy(value)}
      >
        {copied ? <Check className="text-primary" /> : <Copy />}
      </Button>
    </div>
  );
}
