// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Minimal className joiner — no tailwind-merge dependency. The templates in
// this package compose classes additively (base + conditional extras), so
// simple concatenation with falsy-skip is sufficient.
export function cn(...inputs: (string | false | null | undefined)[]): string {
  return inputs.filter(Boolean).join(" ");
}
