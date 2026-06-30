const ENABLED_KEY = "pulldash_notifications_enabled";
const TIMESTAMPS_KEY = "pulldash_notified_timestamps";
const MAX_ENTRIES = 1000;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

const enabledListeners = new Set<() => void>();

function notifyEnabledListeners(): void {
  for (const cb of enabledListeners) cb();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === ENABLED_KEY) notifyEnabledListeners();
  });
}

export function subscribeEnabled(cb: () => void): () => void {
  enabledListeners.add(cb);
  return () => {
    enabledListeners.delete(cb);
  };
}

function prune(data: Record<string, string>): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, timestamp] of Object.entries(data)) {
    if (new Date(timestamp).getTime() < cutoff) {
      delete data[id];
    }
  }
}

export function isSupported(): boolean {
  return "Notification" in window;
}

export function getPermission(): NotificationPermission | "unsupported" {
  if (!isSupported()) return "unsupported";
  return Notification.permission;
}

export function getEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

export function setEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(ENABLED_KEY, "true");
    } else {
      localStorage.removeItem(ENABLED_KEY);
    }
  } catch {
    // ignore
  }
  notifyEnabledListeners();
}

export async function requestPermission(): Promise<boolean> {
  if (!isSupported()) return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function sendNotification(
  title: string,
  body: string,
  url: string,
  icon?: string
): void {
  if (!isSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      icon: icon ?? "/favicon.svg",
    });
    n.onclick = () => {
      n.close();
      window.focus();
      window.location.href = url;
    };
  } catch {
    // ignore
  }
}

export function getNotifiedAt(prId: string): string | null {
  try {
    const data = JSON.parse(localStorage.getItem(TIMESTAMPS_KEY) ?? "{}");
    return data[prId] ?? null;
  } catch {
    return null;
  }
}

export function setNotifiedAt(prId: string, updatedAt: string): void {
  try {
    const data = JSON.parse(localStorage.getItem(TIMESTAMPS_KEY) ?? "{}");
    data[prId] = updatedAt;
    if (Object.keys(data).length > MAX_ENTRIES) {
      prune(data);
    }
    localStorage.setItem(TIMESTAMPS_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}
