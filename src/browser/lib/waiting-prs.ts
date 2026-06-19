const STORAGE_KEY = "pulldash_viewed_prs";

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

export function getLastViewed(prId: string): string | null {
  return read()[prId] ?? null;
}

export function setLastViewed(prId: string): void {
  const data = read();
  data[prId] = new Date().toISOString();
  write(data);
}

export function clearLastViewed(prId: string): void {
  const data = read();
  delete data[prId];
  write(data);
}
