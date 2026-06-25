import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";

// Storage keys
const TOKEN_STORAGE_KEY = "pulldash_github_token";
const TOKEN_EXPIRY_KEY = "pulldash_github_token_expiry";
const REFRESH_TOKEN_KEY = "pulldash_github_refresh_token";
const AUTH_FLOW_KEY = "pulldash_auth_flow";
const CODE_VERIFIER_KEY = "pulldash_code_verifier";

type AuthFlow = "pat" | "device" | "web";

interface AuthConfig {
  flows: AuthFlow[];
  clientId: string;
}

// ============================================================================
// Types
// ============================================================================

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

interface DeviceAuthState {
  status: "idle" | "polling" | "success" | "error";
  userCode: string | null;
  verificationUri: string | null;
  error: string | null;
}

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  token: string | null;
  deviceAuth: DeviceAuthState;
  isRateLimited: boolean;
  authConfig: AuthConfig | null;
  authFlow: AuthFlow | null;
}

interface AuthContextValue extends AuthState {
  startDeviceAuth: () => Promise<void>;
  cancelDeviceAuth: () => void;
  loginWithPAT: (token: string) => Promise<void>;
  startWebAuth: () => Promise<void>;
  exchangeCode: (code: string, codeVerifier?: string) => Promise<void>;
  refreshAccessToken: () => Promise<boolean>;
  logout: () => void;
  canWrite: boolean;
  setRateLimited: (limited: boolean) => void;
  fetchAuthConfig: () => Promise<void>;
}

// ============================================================================
// Context
// ============================================================================

const AuthContext = createContext<AuthContextValue | null>(null);

// ============================================================================
// Helper Functions
// ============================================================================

function getStoredToken(): string | null {
  try {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    const expiry = localStorage.getItem(TOKEN_EXPIRY_KEY);
    if (token) {
      if (expiry) {
        const expiryDate = new Date(expiry);
        if (expiryDate > new Date()) {
          return token;
        }
        clearStoredToken();
        return null;
      }
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

function getStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

function getStoredAuthFlow(): AuthFlow | null {
  try {
    const flow = localStorage.getItem(AUTH_FLOW_KEY);
    if (flow === "pat" || flow === "device" || flow === "web") return flow;
    return null;
  } catch {
    return null;
  }
}

function storeTokens(
  token: string,
  expiresIn?: number,
  refreshToken?: string,
  flow?: AuthFlow
): void {
  try {
    if (refreshToken) {
      // GitHub App: persist refresh token only; access token stays in memory
      localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      localStorage.removeItem(TOKEN_EXPIRY_KEY);
    } else {
      // OAuth App or PAT: persist access token
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
      if (expiresIn) {
        const expiryDate = new Date(Date.now() + expiresIn * 1000);
        localStorage.setItem(TOKEN_EXPIRY_KEY, expiryDate.toISOString());
      } else {
        localStorage.removeItem(TOKEN_EXPIRY_KEY);
      }
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
    if (flow) {
      localStorage.setItem(AUTH_FLOW_KEY, flow);
    }
  } catch {
    console.error("Failed to store token in localStorage");
  }
}

function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // Ignore
  }
}

const STORAGE_KEYS_TO_CLEAR: string[] = [
  "pulldash_auth_flow",
  "pulldash-theme",
  "pulldash_diff_view_mode",
  "pulldash_conversations_filters",
  "pulldash_notifications_enabled",
  "pulldash_notified_timestamps",
  "pulldash_filter_config",
  "pulldash_show_updated_only",
  "pulldash_tabs",
  "pulldash-bookmarklet-dismissed",
  "pulldash_viewed_prs",
];

function clearAllStorage(): void {
  try {
    // Remove known preference keys
    for (const key of STORAGE_KEYS_TO_CLEAR) {
      localStorage.removeItem(key);
    }

    // Remove legacy pr-* preference keys
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("pr-")) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
    }

    // Clear sessionStorage (PKCE verifier, etc.)
    sessionStorage.clear();

    // Delete IndexedDB cache
    try {
      indexedDB.deleteDatabase("pulldash");
    } catch {
      // IndexedDB may not be available
    }
  } catch {
    // Ignore storage errors
  }
}

// PKCE helpers
function generateCodeVerifier(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join("");
}

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64url(bytes);
}

// Track in-memory access token ref (for web flow only, cleared on tab close)
let inMemoryToken: string | null = null;

function setInMemoryToken(token: string | null) {
  inMemoryToken = token;
}

export function getEffectiveToken(): string | null {
  if (inMemoryToken) return inMemoryToken;
  return getStoredToken();
}

export function hasRefreshToken(): boolean {
  return !!getStoredRefreshToken();
}

function hasRefreshTokenValue(refreshToken?: string): boolean {
  return !!refreshToken;
}

// ============================================================================
// Provider
// ============================================================================

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const storedFlow = getStoredAuthFlow();
    const storedToken = getStoredToken();
    const storedRefreshToken = getStoredRefreshToken();
    let token: string | null = null;
    let isAuthenticated = false;

    // If a refresh token exists, we can keep the access token in memory
    if (storedRefreshToken && storedToken) {
      setInMemoryToken(storedToken);
      token = storedToken;
      isAuthenticated = true;
      try {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        localStorage.removeItem(TOKEN_EXPIRY_KEY);
      } catch {}
    } else if (storedRefreshToken && !storedToken) {
      // Have refresh token but no access token — will refresh on mount
      isAuthenticated = false;
    } else if (storedToken) {
      // No refresh token — access token in localStorage (OAuth App or PAT)
      token = storedToken;
      isAuthenticated = true;
    }

    return {
      isAuthenticated,
      isLoading: false,
      token,
      deviceAuth: {
        status: "idle",
        userCode: null,
        verificationUri: null,
        error: null,
      },
      isRateLimited: false,
      authConfig: null,
      authFlow: storedFlow,
    };
  });

  const [abortController, setAbortController] =
    useState<AbortController | null>(null);

  const setRateLimited = useCallback((limited: boolean) => {
    setState((prev) => ({ ...prev, isRateLimited: limited }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortController?.abort();
    };
  }, [abortController]);

  const fetchAuthConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/config");
      if (res.ok) {
        const config: AuthConfig = await res.json();
        setState((prev) => ({ ...prev, authConfig: config }));
      }
    } catch {
      // server may not be available
    }
  }, []);

  // On mount: handle OAuth callback, refresh token, fetch config
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const authError = params.get("auth_error");

    if (code) {
      // OAuth redirect — exchange code with PKCE verifier
      let codeVerifier: string | null = null;
      try {
        codeVerifier = sessionStorage.getItem(CODE_VERIFIER_KEY);
        sessionStorage.removeItem(CODE_VERIFIER_KEY);
      } catch {
        // sessionStorage may not be available
      }

      exchangeCode(code, codeVerifier ?? undefined)
        .then(() => {
          window.history.replaceState(null, "", window.location.pathname);
        })
        .catch(() => {
          window.history.replaceState(null, "", window.location.pathname);
        });
      return;
    }

    if (authError) {
      window.history.replaceState(null, "", window.location.pathname);
      return;
    }

    if (getStoredRefreshToken() && !state.isAuthenticated) {
      refreshAccessToken();
    }
    fetchAuthConfig();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshAccessToken = useCallback(async (): Promise<boolean> => {
    const refreshToken = getStoredRefreshToken();
    if (!refreshToken) return false;

    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!res.ok) return false;

      const data: TokenResponse = await res.json();
      if (data.access_token) {
        setInMemoryToken(data.access_token);
        storeTokens(
          data.access_token,
          data.expires_in,
          data.refresh_token || refreshToken,
          state.authFlow ?? undefined
        );
        setState((prev) => ({
          ...prev,
          isAuthenticated: true,
          token: data.access_token,
          isLoading: false,
        }));
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const startDeviceAuth = useCallback(async () => {
    abortController?.abort();
    const newController = new AbortController();
    setAbortController(newController);

    setState((prev) => ({
      ...prev,
      isLoading: true,
      deviceAuth: {
        status: "polling",
        userCode: null,
        verificationUri: null,
        error: null,
      },
    }));

    try {
      const deviceCodeRes = await fetch("/api/auth/device/code", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        signal: newController.signal,
      });

      if (!deviceCodeRes.ok) {
        const errorData = await deviceCodeRes.json().catch(() => ({}));
        throw new Error(
          errorData.error || "Failed to initiate device authorization"
        );
      }

      const deviceCode: DeviceCodeResponse = await deviceCodeRes.json();

      setState((prev) => ({
        ...prev,
        deviceAuth: {
          ...prev.deviceAuth,
          userCode: deviceCode.user_code,
          verificationUri: deviceCode.verification_uri,
        },
      }));

      const pollInterval = (deviceCode.interval || 5) * 1000;
      const expiresAt = Date.now() + deviceCode.expires_in * 1000;

      while (Date.now() < expiresAt) {
        if (newController.signal.aborted) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));

        if (newController.signal.aborted) {
          return;
        }

        try {
          const tokenRes = await fetch("/api/auth/device/token", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              device_code: deviceCode.device_code,
            }),
            signal: newController.signal,
          });

          const tokenData: TokenResponse = await tokenRes.json();

          if (tokenData.error) {
            if (tokenData.error === "authorization_pending") {
              continue;
            } else if (tokenData.error === "slow_down") {
              await new Promise((resolve) => setTimeout(resolve, 5000));
              continue;
            } else if (tokenData.error === "expired_token") {
              throw new Error("Authorization expired. Please try again.");
            } else if (tokenData.error === "access_denied") {
              throw new Error("Authorization was denied.");
            } else {
              throw new Error(tokenData.error_description || tokenData.error);
            }
          }

          if (tokenData.access_token) {
            const useMemory = hasRefreshTokenValue(tokenData.refresh_token);
            if (useMemory) {
              setInMemoryToken(tokenData.access_token);
            } else {
              setInMemoryToken(null);
            }
            storeTokens(
              tokenData.access_token,
              tokenData.expires_in,
              tokenData.refresh_token,
              "device"
            );
            setState((prev) => ({
              ...prev,
              isAuthenticated: true,
              isLoading: false,
              token: tokenData.access_token,
              deviceAuth: {
                status: "success",
                userCode: null,
                verificationUri: null,
                error: null,
              },
              isRateLimited: false,
              authFlow: "device",
            }));
            return;
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            return;
          }
          throw err;
        }
      }

      throw new Error("Authorization expired. Please try again.");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          deviceAuth: {
            status: "idle",
            userCode: null,
            verificationUri: null,
            error: null,
          },
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        isLoading: false,
        deviceAuth: {
          status: "error",
          userCode: null,
          verificationUri: null,
          error: (err as Error).message,
        },
      }));
    }
  }, [abortController]);

  const cancelDeviceAuth = useCallback(() => {
    abortController?.abort();
    setState((prev) => ({
      ...prev,
      isLoading: false,
      deviceAuth: {
        status: "idle",
        userCode: null,
        verificationUri: null,
        error: null,
      },
    }));
  }, [abortController]);

  const startWebAuth = useCallback(async () => {
    const config = state.authConfig;
    if (!config) return;

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    try {
      sessionStorage.setItem(CODE_VERIFIER_KEY, codeVerifier);
    } catch {
      // sessionStorage may not be available
    }

    const redirectUri = `${window.location.origin}/api/auth/callback`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: "repo read:user",
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
    });
    window.location.href = `https://github.com/login/oauth/authorize?${params}`;
  }, [state.authConfig]);

  const exchangeCode = useCallback(
    async (code: string, codeVerifier?: string) => {
      setState((prev) => ({ ...prev, isLoading: true }));

      try {
        const body: Record<string, string> = { code };
        if (codeVerifier) body.code_verifier = codeVerifier;
        const res = await fetch("/api/auth/callback", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const data: TokenResponse = await res.json();

        if (data.access_token) {
          const useMemory = hasRefreshTokenValue(data.refresh_token);
          if (useMemory) {
            setInMemoryToken(data.access_token);
          } else {
            setInMemoryToken(null);
          }
          storeTokens(
            data.access_token,
            data.expires_in,
            data.refresh_token,
            "web"
          );
          setState((prev) => ({
            ...prev,
            isAuthenticated: true,
            isLoading: false,
            token: data.access_token,
            deviceAuth: {
              status: "idle",
              userCode: null,
              verificationUri: null,
              error: null,
            },
            isRateLimited: false,
            authFlow: "web",
          }));
        } else {
          throw new Error(data.error_description || "Failed to authenticate");
        }
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
        }));
        throw err;
      }
    },
    []
  );

  const loginWithPAT = useCallback(async (token: string): Promise<void> => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      throw new Error("Token cannot be empty");
    }

    if (
      !trimmedToken.startsWith("ghp_") &&
      !trimmedToken.startsWith("github_pat_")
    ) {
      throw new Error(
        'Invalid token format. GitHub tokens should start with "ghp_" or "github_pat_"'
      );
    }

    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${trimmedToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Invalid or expired token");
      }
      throw new Error("Failed to validate token with GitHub");
    }

    const userData = await response.json();

    const scopes = response.headers.get("x-oauth-scopes") || "";
    const hasRepoScope =
      scopes.includes("repo") || scopes.includes("public_repo");

    if (!hasRepoScope) {
      throw new Error(
        'Token is missing the required "repo" or "public_repo" scope. Please create a token with the repo scope (for private repos) or public_repo scope (for public repos only).'
      );
    }

    setInMemoryToken(null);
    storeTokens(trimmedToken, undefined, undefined, "pat");
    setState((prev) => ({
      ...prev,
      isAuthenticated: true,
      isLoading: false,
      token: trimmedToken,
      deviceAuth: {
        status: "idle",
        userCode: null,
        verificationUri: null,
        error: null,
      },
      isRateLimited: false,
      authFlow: "pat",
    }));

    console.log("Successfully authenticated with PAT as:", userData.login);
  }, []);

  const logout = useCallback(() => {
    setInMemoryToken(null);
    clearStoredToken();
    clearAllStorage();
    setState((prev) => ({
      ...prev,
      isAuthenticated: false,
      isLoading: false,
      token: null,
      deviceAuth: {
        status: "idle",
        userCode: null,
        verificationUri: null,
        error: null,
      },
      isRateLimited: false,
      authFlow: null,
    }));
    fetchAuthConfig();
  }, [fetchAuthConfig]);

  const value: AuthContextValue = {
    ...state,
    startDeviceAuth,
    cancelDeviceAuth,
    loginWithPAT,
    startWebAuth,
    exchangeCode,
    refreshAccessToken,
    logout,
    canWrite: state.isAuthenticated,
    setRateLimited,
    fetchAuthConfig,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ============================================================================
// Hooks
// ============================================================================

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

export function useToken(): string | null {
  return getEffectiveToken();
}

export function useIsAuthenticated(): boolean {
  const { isAuthenticated } = useAuth();
  return isAuthenticated;
}

export function useCanWrite(): boolean {
  const { canWrite } = useAuth();
  return canWrite;
}
