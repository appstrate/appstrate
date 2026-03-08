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

const stored = (localStorage.getItem(STORAGE_KEY) as Theme) || "system";

export const useThemeStore = create<ThemeState>()((set) => ({
  theme: stored,
  resolvedTheme: resolve(stored),
  setTheme: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    const resolvedTheme = resolve(theme);
    applyTheme(resolvedTheme);
    set({ theme, resolvedTheme });
  },
}));

// Apply theme on load
applyTheme(useThemeStore.getState().resolvedTheme);

// React to system theme changes when in "system" mode
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const { theme } = useThemeStore.getState();
  if (theme === "system") {
    const resolvedTheme = getSystemTheme();
    applyTheme(resolvedTheme);
    useThemeStore.setState({ resolvedTheme });
  }
});
