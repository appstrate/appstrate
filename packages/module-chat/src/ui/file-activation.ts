// SPDX-License-Identifier: Apache-2.0

/**
 * The single opener-vs-download decision for a chat-surfaced file, shared by
 * the sent-attachment chips (`thread.tsx`) and the run-progress file chips
 * (`chat-run-progress-card.tsx`). With a host opener (web shell) a file
 * opens the in-app preview modal; without one it falls back to the host's
 * authenticated download. The same choice drives the click action and its label.
 *
 * A pure function (not a hook): callers already hold `opener` / `download` / `t`
 * from their own top-level hook calls and pass them in, so this composes cleanly
 * inside conditionals and `.map` bodies.
 */

import type { OpenFile, DownloadFile, ChatTranslate } from "./runtime-context.ts";
import { UNNAMED_FILE } from "./run-events.ts";

export function fileActivation(
  file: { id: string; name: string },
  opener: OpenFile | null,
  download: DownloadFile,
  t: ChatTranslate,
): { onActivate: () => void; label: string } {
  const { id, name } = file;
  // The bare fallback only feeds the download filename, and MUST stay
  // untranslated: this string is what the browser saves the file as, so a
  // localized value would put «Fichier sans nom» on one reader's disk and
  // something else on the next one's. The label uses the translated
  // placeholder instead, so the sentence stays grammatical in every language.
  const fileName = name || UNNAMED_FILE;
  const labelName = name || t("file.unnamed");
  const onActivate = opener ? () => opener({ id, name: fileName }) : () => download(id, fileName);
  const label = opener
    ? t("file.previewOf", { name: labelName })
    : t("file.downloadOf", { name: labelName });
  return { onActivate, label };
}
