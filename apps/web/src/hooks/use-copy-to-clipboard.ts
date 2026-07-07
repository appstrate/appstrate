// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from "react";

/**
 * Copy text to clipboard with a "copied" state that resets after a delay.
 *
 * `navigator.clipboard` is undefined outside a secure context (plain HTTP,
 * some embedded webviews) and `writeText` can reject even when present, so
 * the copy is guarded and awaited: the returned promise resolves to whether
 * the copy actually succeeded, and `copied` only flips on a real success.
 */
export function useCopyToClipboard(resetMs = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      if (!navigator.clipboard?.writeText) {
        setCopied(false);
        return false;
      }
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), resetMs);
        return true;
      } catch {
        setCopied(false);
        return false;
      }
    },
    [resetMs],
  );

  return { copied, copy };
}
