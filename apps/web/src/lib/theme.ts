// SPDX-License-Identifier: Apache-2.0

import { Sun, Moon, Monitor, type LucideIcon } from "lucide-react";
import type { Theme } from "../stores/theme-store";

export const themeOptions: { value: Theme; labelKey: string; icon: LucideIcon }[] = [
  { value: "light", labelKey: "userMenu.themeLight", icon: Sun },
  { value: "dark", labelKey: "userMenu.themeDark", icon: Moon },
  { value: "system", labelKey: "userMenu.themeSystem", icon: Monitor },
];
