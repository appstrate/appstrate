// SPDX-License-Identifier: Apache-2.0

import type { OpenFile, ChatTranslate } from "./runtime-context.ts";
import { UNNAMED_FILE } from "./run-events.ts";

/** Open a stored file in its own space, with a localized label for unnamed files. */
export function fileActivation(
  file: { id: string; name: string; spaceId?: string },
  openFile: OpenFile,
  t: ChatTranslate,
): { onActivate: () => void; label: string } {
  const { id, name, spaceId } = file;
  return {
    onActivate: () => openFile({ id, name: name || UNNAMED_FILE, ...(spaceId && { spaceId }) }),
    label: t("file.previewOf", { name: name || t("file.unnamed") }),
  };
}
