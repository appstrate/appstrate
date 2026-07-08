// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";

export type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "appstrate-theme";

function getSystemTheme(): "dark" | "light" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "dark" | "light") {
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
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

// Accessing localStorage throws when storage is blocked (sandboxed iframe,
// Safari private mode, cookies-disabled). Guard it so a blocked store can
// never crash the SPA bootstrap — we just fall back to the default theme.
function readStoredTheme(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

const stored = parseStoredTheme(readStoredTheme());

export const useTheme = create<ThemeState>()((set) => ({
  theme: stored,
  resolvedTheme: resolve(stored),
  setTheme: (theme) => {
    // Persist best-effort — a blocked store must not throw out of setTheme.
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage blocked — theme just won't persist across reloads.
    }
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
