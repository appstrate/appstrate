// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { LOCAL_STORAGE_KEYS, createLocalStore, scalarCodec } from "@appstrate/ui/local-storage";
import { THEME_COLORS } from "./theme-colors";

export type Theme = "dark" | "light" | "system";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "dark" | "light") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[resolved]);
}

interface ThemeState {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
}

function resolve(theme: Theme): "dark" | "light" {
  return theme === "system" ? getSystemTheme() : theme;
}

const THEMES: readonly Theme[] = ["dark", "light", "system"];

/** Coerce an untrusted localStorage value into a valid Theme, defaulting to "system". */
function parseStoredTheme(value: string | null): Theme {
  return value && (THEMES as readonly string[]).includes(value) ? (value as Theme) : "system";
}

const storedTheme = createLocalStore(LOCAL_STORAGE_KEYS.theme, scalarCodec(parseStoredTheme));
const stored = storedTheme.read();

export const useTheme = create<ThemeState>()((set) => ({
  theme: stored,
  resolvedTheme: resolve(stored),
  setTheme: (theme) => {
    storedTheme.write(theme);
    const resolvedTheme = resolve(theme);
    applyTheme(resolvedTheme);
    set({ theme, resolvedTheme });
  },
}));

// Apply theme on load
applyTheme(useTheme.getState().resolvedTheme);

// React to system theme changes when in "system" mode
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const { theme } = useTheme.getState();
  if (theme === "system") {
    const resolvedTheme = getSystemTheme();
    applyTheme(resolvedTheme);
    useTheme.setState({ resolvedTheme });
  }
});
