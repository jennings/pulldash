const ENABLED_KEY = "pulldash_notifications_enabled";
const TIMESTAMPS_KEY = "pulldash_notified_timestamps";

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
    localStorage.setItem(TIMESTAMPS_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}
