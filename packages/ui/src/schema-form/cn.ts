// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Thin wrapper around `tailwind-merge` so conflicting Tailwind utilities
// (e.g. base `border-input` + conditional `border-destructive`) resolve
// deterministically by attribute order rather than CSS source order.
import { twMerge } from "tailwind-merge";

export function cn(...inputs: (string | false | null | undefined)[]): string {
  return twMerge(inputs.filter(Boolean).join(" "));
}
