// SPDX-License-Identifier: Apache-2.0

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with Tailwind conflict resolution (clsx + tailwind-merge).
 * Canonical for every Appstrate surface — components, schema-form widgets and
 * the web app all import this one implementation via `@appstrate/ui/cn`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
