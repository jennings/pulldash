import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { toggleTheme as toggleThemeImpl, getCurrentTheme } from "../theme";

interface ThemeContextValue {
  theme: "dark" | "light";
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(getCurrentTheme);

  const toggle = useCallback(() => {
    toggleThemeImpl();
    setTheme(getCurrentTheme());
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(getCurrentTheme());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  const value: ThemeContextValue = { theme, toggleTheme: toggle };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
