// SPDX-License-Identifier: Apache-2.0

/**
 * An inline editor's input (`InlineEditableLabel`, `InlineTextSetting`) is marked so the row
 * around it can find it, e.g. to focus it once a menu closes.
 */
const attribute = "data-inline-editing";
export const inlineEditingAttributes = { [attribute]: "" } as const;
export const inlineEditingSelector = `[${attribute}]`;
