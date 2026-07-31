// SPDX-License-Identifier: Apache-2.0

/**
 * The single opener-vs-download decision for a chat-surfaced document, shared by
 * the sent-attachment chips (`thread.tsx`) and the run-progress document chips
 * (`chat-run-progress-card.tsx`). With a host opener (web shell) a document
 * opens the in-app preview modal; without one it falls back to the host's
 * authenticated download. The same choice drives the click action and its label.
 *
 * A pure function (not a hook): callers already hold `opener` / `download` / `t`
 * from their own top-level hook calls and pass them in, so this composes cleanly
 * inside conditionals and `.map` bodies.
 */

import type { OpenDocument, DownloadDocument, ChatTranslate } from "./runtime-context.ts";

export function documentActivation(
  doc: { id: string; name: string },
  opener: OpenDocument | null,
  download: DownloadDocument,
  t: ChatTranslate,
): { onActivate: () => void; label: string } {
  const { id, name } = doc;
  // The bare fallback only feeds the download filename; the label uses its own
  // translated placeholder so the sentence stays grammatical in every language.
  const fileName = name || "document";
  const labelName = name || t("doc.unnamed");
  const onActivate = opener
    ? () => opener({ id, name: fileName }, { trigger: "manual" })
    : () => download(id, fileName);
  const label = opener
    ? t("doc.previewOf", { name: labelName })
    : t("doc.downloadOf", { name: labelName });
  return { onActivate, label };
}
