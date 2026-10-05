// SPDX-License-Identifier: Apache-2.0

/** The SHOWN tab a settings URL belongs to; `undefined` on a URL the caller has no tab for. */
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
