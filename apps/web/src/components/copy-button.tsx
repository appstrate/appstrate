// SPDX-License-Identifier: Apache-2.0

import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";

/**
 * The one copy affordance. `icon` is a square ghost button (beside a value);
 * `text` is an outline button that says « Copier » / « Copié ». `getValue`
 * computes the string at click time (a URL built from the current location).
 * The check appears only when the clipboard write really succeeded.
 */
export function CopyButton({
  variant = "icon",
  className,
  label,
  "aria-label": ariaLabel,
  ...source
}: {
  variant?: "icon" | "text";
  className?: string;
  /** Overrides « Copier » (the icon button's accessible name, the text button's word). */
  label?: string;
  /** What a screen reader hears when the word alone does not say what is copied. */
  "aria-label"?: string;
} & ({ value: string; getValue?: never } | { value?: never; getValue: () => string })) {
  const { t } = useTranslation("common");
  const { copied, copy } = useCopyToClipboard();
  const name = label ?? t("btn.copy");
  const onClick = () => void copy(source.getValue ? source.getValue() : source.value);

  if (variant === "text") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        aria-label={ariaLabel}
        onClick={onClick}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
        {copied ? t("btn.copied") : name}
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("text-muted-foreground hover:text-foreground h-7 w-7", className)}
      aria-label={ariaLabel ?? name}
      title={name}
      onClick={onClick}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}
