const ENABLED_KEY = "pulldash_notifications_enabled";
const TIMESTAMPS_KEY = "pulldash_notified_timestamps";
const SELF_ACTIVITY_KEY = "pulldash_self_activity";
const MERGED_KEY = "pulldash_merged_seen";
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
  return new NotificationBatch().getNotifiedAt(prId);
}

export function setNotifiedAt(prId: string, updatedAt: string): void {
  const batch = new NotificationBatch();
  batch.setNotifiedAt(prId, updatedAt);
  batch.flush();
}

// Marks that pulldash itself just mutated this PR, so the poll can suppress
// the notification for the activity that change causes. The marker is
// intentionally persistent (no TTL): it stays valid until the poll processes
// the mutation's own updatedAt bump.
export function markSelfActivity(prId: string): void {
  try {
    const data = JSON.parse(localStorage.getItem(SELF_ACTIVITY_KEY) ?? "{}");
    data[prId] = Date.now();
    localStorage.setItem(SELF_ACTIVITY_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

// One-shot: returns (and clears) whether the next activity on this PR was
// caused by pulldash itself.
export function consumeSelfActivity(prId: string): boolean {
  const batch = new NotificationBatch();
  const consumed = batch.consumeSelfActivity(prId);
  batch.flush();
  return consumed;
}

function readRecord<T>(key: string): Record<string, T> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {
    // Ignore unavailable or corrupt storage.
  }
  return {};
}

// A poll is synchronous after fetching enrichment. Keep its storage snapshot
// local to that pass, so later polls and other windows see fresh values.
export class NotificationBatch {
  private records = new Map<string, Record<string, unknown>>();
  private dirty = new Set<string>();

  private read<T>(key: string): Record<string, T> {
    if (!this.records.has(key)) this.records.set(key, readRecord(key));
    return this.records.get(key)! as Record<string, T>;
  }

  getNotifiedAt(prId: string): string | null {
    return this.read<string>(TIMESTAMPS_KEY)[prId] ?? null;
  }

  setNotifiedAt(prId: string, updatedAt: string): void {
    const data = this.read<string>(TIMESTAMPS_KEY);
    if (data[prId] === updatedAt) return;
    data[prId] = updatedAt;
    this.dirty.add(TIMESTAMPS_KEY);
  }

  consumeSelfActivity(prId: string): boolean {
    const data = this.read<number>(SELF_ACTIVITY_KEY);
    if (!(prId in data)) return false;
    delete data[prId];
    this.dirty.add(SELF_ACTIVITY_KEY);
    return true;
  }

  observeMergedState(prId: string, merged: boolean): boolean {
    const data = this.read<{ m: number; t: number }>(MERGED_KEY);
    const previous = data[prId];
    if (previous?.m === Number(merged)) return false;
    data[prId] = { m: Number(merged), t: Date.now() };
    this.dirty.add(MERGED_KEY);
    return previous?.m === 0 && merged;
  }

  flush(): void {
    for (const key of this.dirty) {
      try {
        const data = this.records.get(key)!;
        if (Object.keys(data).length > MAX_ENTRIES) {
          if (key === TIMESTAMPS_KEY) prune(data as Record<string, string>);
          if (key === MERGED_KEY) {
            const cutoff = Date.now() - MAX_AGE_MS;
            for (const [id, entry] of Object.entries(data)) {
              if ((entry as { t: number }).t < cutoff) delete data[id];
            }
          }
        }
        localStorage.setItem(key, JSON.stringify(data));
      } catch {
        // ignore
      }
    }
    this.dirty.clear();
  }
}

// Records the observed merged state and reports whether it just transitioned
// from unmerged to merged. First-ever observation is never a transition, so
// already-merged PRs stay silent on startup.
export function observeMergedState(prId: string, merged: boolean): boolean {
  const batch = new NotificationBatch();
  const transitioned = batch.observeMergedState(prId, merged);
  batch.flush();
  return transitioned;
}
