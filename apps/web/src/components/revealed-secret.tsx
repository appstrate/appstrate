// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";
import { Button } from "@/components/ui/button";

interface Props {
  /** The secret value to reveal and copy. */
  secret: string;
  /** Warning banner shown above the secret box. */
  warning: string;
}

/**
 * Display a one-time-revealed secret (API key, webhook secret, ...) with a
 * copy-to-clipboard button. The secret is shown verbatim — callers must only
 * mount this component when they intend to reveal the value.
 */
export function RevealedSecret({ secret, warning }: Props) {
  const { t } = useTranslation(["common"]);
  const { copied, copy } = useCopyToClipboard();

  return (
    <>
      <p className="text-warning bg-warning/10 rounded-md px-3 py-2 text-sm">{warning}</p>
      <div className="border-border bg-muted/50 mt-3 flex items-center gap-2 rounded-md border px-3 py-2">
        <code className="text-foreground flex-1 font-mono text-xs break-all">{secret}</code>
        <Button
          variant="ghost"
          size="sm"
          className="text-primary shrink-0 text-xs hover:underline"
          onClick={() => copy(secret)}
        >
          {copied ? t("common:btn.copied") : t("common:btn.copy")}
        </Button>
      </div>
    </>
  );
}
