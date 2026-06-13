const STORAGE_KEY = "pulldash-theme";
type Theme = "dark" | "light";
let mediaQuery: MediaQueryList | null = null;

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
}

function getSystemTheme(): Theme {
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return getSystemTheme();
}

export function setTheme(theme: Theme) {
  applyTheme(theme);
  localStorage.setItem(STORAGE_KEY, theme);
}

export function toggleTheme(): Theme {
  const current: Theme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "light";
  const next: Theme = current === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function getCurrentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function initTheme() {
  setTheme(getInitialTheme());

  // Listen for system preference changes when no manual override is saved
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored !== "dark" && stored !== "light") {
    mediaQuery = matchMedia("(prefers-color-scheme: light)");
    mediaQuery.addEventListener("change", () => {
      if (!localStorage.getItem(STORAGE_KEY)) {
        applyTheme(getSystemTheme());
      }
    });
  }
}
