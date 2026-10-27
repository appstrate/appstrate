// SPDX-License-Identifier: Apache-2.0

/**
 * Escape inside an inline rename (`InlineEditableLabel`, which marks its input
 * `data-inline-editing`) cancels the rename only: the dialog around it stays
 * open. Radix listens for Escape on the document before the input sees it, so
 * the dialog has to ask.
 */
export function keepOpenWhileRenaming(event: KeyboardEvent): void {
  if (document.activeElement?.closest("[data-inline-editing]")) event.preventDefault();
}
