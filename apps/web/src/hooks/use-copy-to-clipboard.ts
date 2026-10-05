// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from "react";
import { toast } from "sonner";
import i18n from "../i18n";

/**
 * Write `text` to the clipboard and say so when the browser will not:
 * `navigator.clipboard` is undefined outside a secure context (plain HTTP, some
 * embedded webviews) and `writeText` rejects when the permission is denied —
 * a button that then does nothing reads as a copy that worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast.error(i18n.t("error.copyFailed"));
    return false;
  }
}

/**
 * Copy text to clipboard with a "copied" state that resets after a delay. The
 * returned promise resolves to whether the copy actually succeeded, and
 * `copied` only flips on a real success.
 */
export function useCopyToClipboard(resetMs = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const ok = await copyText(text);
      setCopied(ok);
      if (ok) setTimeout(() => setCopied(false), resetMs);
      return ok;
    },
    [resetMs],
  );

  return { copied, copy };
}
