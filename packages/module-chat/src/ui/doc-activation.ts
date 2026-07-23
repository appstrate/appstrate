// SPDX-License-Identifier: Apache-2.0

/**
 * The single opener-vs-download decision for a chat-surfaced document, shared by
 * the sent-attachment chips (`thread.tsx`) and the run-progress document chips
 * (`chat-run-progress-card.tsx`). With a host opener (web shell) a document
 * opens the in-app preview modal; without one (embedded mounts) it falls back to
 * the authenticated download. The same choice drives the click action and its
 * label ("Aperçu de X" vs "Télécharger X").
 *
 * A pure function (not a hook): callers already hold `opener`/`getHeaders` from
 * their own top-level hook calls and pass them in, so this composes cleanly
 * inside conditionals and `.map` bodies.
 */

import type { OpenDocument, GetHeaders } from "./runtime-context.ts";
import { downloadChatDocument } from "./document-download.ts";

export function documentActivation(
  doc: { id: string; name: string },
  opener: OpenDocument | null,
  getHeaders: GetHeaders | null,
): { onActivate: () => void; label: string } {
  const { id, name } = doc;
  const actionName = name || "document";
  const labelName = name || "le document";
  const onActivate = opener
    ? () => opener({ id, name: actionName })
    : () => void downloadChatDocument(id, actionName, getHeaders?.() ?? {});
  const label = opener ? `Aperçu de ${labelName}` : `Télécharger ${labelName}`;
  return { onActivate, label };
}
