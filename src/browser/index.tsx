import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/auth";
import { GitHubProvider } from "./contexts/github";
import { TabProvider } from "./contexts/tabs";
import { ThemeProvider } from "./contexts/theme";
import { CommandPaletteProvider } from "./components/command-palette";
import { AppShell } from "./components/app-shell";
import { WelcomeDialog } from "./components/welcome-dialog";
import { initTheme } from "./theme";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { queryClient, persister } from "./lib/query-client";
import "./index.css";

// Initialize theme before rendering to avoid flash
initTheme();

// Register service worker for PWA installability
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

createRoot(document.getElementById("app")!).render(
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={{
      persister,
      dehydrateOptions: {
        shouldDehydrateQuery: (query) => query.meta?.persist === true,
      },
    }}
  >
    <ThemeProvider>
      <AuthProvider>
        <GitHubProvider>
          <BrowserRouter>
            <TabProvider>
              <CommandPaletteProvider>
                <Routes>
                  {/* Home */}
                  <Route path="/" element={<AppShell />} />
                  {/* PR review - URL like /:owner/:repo/pull/:number */}
                  <Route
                    path="/:owner/:repo/pull/:number"
                    element={<AppShell />}
                  />
                </Routes>
                {/* Auth dialog - shown when not authenticated */}
                <WelcomeDialog />
              </CommandPaletteProvider>
            </TabProvider>
          </BrowserRouter>
        </GitHubProvider>
      </AuthProvider>
    </ThemeProvider>
    {__DEV__ && <ReactQueryDevtools initialIsOpen={false} />}
  </PersistQueryClientProvider>
);
