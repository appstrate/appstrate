// SPDX-License-Identifier: Apache-2.0

const attribute = "data-inline-editing";

export const inlineEditingAttributes = { [attribute]: "" } as const;

export const inlineEditingSelector = `[${attribute}]`;

/**
 * Escape inside an inline rename (`InlineEditableLabel`, which marks its input
 * `data-inline-editing`) cancels the rename only: the dialog around it stays
 * open. The dialog hears Escape on the document before the input does, so its
 * `onOpenChange` asks this before closing.
 */
export function isRenameEscape(details: { reason: string }): boolean {
  return (
    details.reason === "escape-key" &&
    document.activeElement?.closest(inlineEditingSelector) != null
  );
}
