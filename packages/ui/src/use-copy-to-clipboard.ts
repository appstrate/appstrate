// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useUiLabels } from "./components/ui-labels.ts";

/**
 * Reports a refused write: `navigator.clipboard` is undefined outside a secure
 * context and `writeText` rejects when the permission is denied.
 */
export async function copyText(text: string, failureMessage: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error(failureMessage);
    return false;
  }
}

/** Copy with a "copied" state that resets after a delay and only flips on a real success. */
export function useCopyToClipboard(resetMs = 2000) {
  const { copyFailed } = useUiLabels();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const ok = await copyText(text, copyFailed);
      setCopied(ok);
      if (ok) setTimeout(() => setCopied(false), resetMs);
      return ok;
    },
    [copyFailed, resetMs],
  );

  return { copied, copy };
}
