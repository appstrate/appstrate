// SPDX-License-Identifier: Apache-2.0

/**
 * A tool of the saved selection stays toggleable, dropped or not, so the author can take it
 * back; an unusable one that was never selected cannot be added.
 */
export function isToolToggleDisabled(tool: {
  unusable: boolean;
  selected: boolean;
  saved: boolean;
}): boolean {
  return tool.unusable && !tool.selected && !tool.saved;
}
