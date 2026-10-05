// SPDX-License-Identifier: Apache-2.0

/**
 * The tab a settings URL belongs to, among the tabs the caller is SHOWN.
 * `undefined` on a URL they have no tab for (a refused page): the breadcrumb
 * and the tab selector both read this, so neither titles such a page — least of
 * all with another tab's name.
 */
export function activeSettingsItem<T extends { to: string; show?: boolean }>(
  items: readonly T[],
  pathname: string,
): T | undefined {
  const shown = items.filter((item) => item.show !== false);
  return (
    shown.find((item) => pathname === item.to) ??
    shown.find((item) => pathname.startsWith(item.to + "/"))
  );
}
