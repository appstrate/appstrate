// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Minimal className joiner — no `tailwind-merge` / `clsx` dependency so the
// package stays dep-light for external consumers (portal, future surfaces).
// Templates here compose classes additively (base + conditional extras) and
// never produce conflicting Tailwind utilities, so simple concatenation with
// falsy-skip is sufficient. Swap for `twMerge` if that invariant changes
// rather than sprinkling conditionals at call sites.
export function cn(...inputs: (string | false | null | undefined)[]): string {
  return inputs.filter(Boolean).join(" ");
}
