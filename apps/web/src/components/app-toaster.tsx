// SPDX-License-Identifier: Apache-2.0

import { Toaster } from "@appstrate/ui/components/sonner";
import { useTheme } from "../stores/theme-store";

/** Shared Sonner toaster bound to the user's resolved theme. */
export function AppToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster theme={resolvedTheme} />;
}
