const STORAGE_KEY = "pulldash_viewed_prs";
const MAX_ENTRIES = 1000;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

interface ViewedPrs {
  [prId: string]: string;
}

function read(): ViewedPrs {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function write(data: ViewedPrs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function prune(data: ViewedPrs): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, timestamp] of Object.entries(data)) {
    if (new Date(timestamp).getTime() < cutoff) {
      delete data[id];
    }
  }
}

export function getLastViewed(prId: string): string | null {
  return read()[prId] ?? null;
}

export function setLastViewed(prId: string): void {
  const data = read();
  data[prId] = new Date().toISOString();
  if (Object.keys(data).length > MAX_ENTRIES) {
    prune(data);
  }
  write(data);
}

export function clearLastViewed(prId: string): void {
  const data = read();
  delete data[prId];
  if (Object.keys(data).length > MAX_ENTRIES) {
    prune(data);
  }
  write(data);
}
