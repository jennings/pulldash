// PersistentCache: IndexedDB-backed cache for immutable (SHA-keyed) GitHub API responses.
// Each entry is tagged with a prKey so all entries for a closed PR can be bulk-deleted.

const DB_NAME = "pulldash";
const STORE_NAME = "responses";
const DB_VERSION = 1;

interface CacheEntry<T> {
  cacheKey: string;
  prKey: string;
  value: T;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
        store.createIndex("prKey", "prKey", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  return dbPromise;
}

export async function get<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => {
      const entry = req.result as CacheEntry<T> | undefined;
      resolve(entry ? entry.value : null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function put<T>(
  key: string,
  value: T,
  prKey: string
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const entry: CacheEntry<T> = { cacheKey: key, prKey, value };
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => {
      if (
        req.error?.name === "QuotaExceededError" ||
        (tx as IDBTransaction & { error?: DOMException }).error?.name ===
          "QuotaExceededError"
      ) {
        console.warn("PersistentCache: QuotaExceededError, skipping put");
        resolve();
      } else {
        reject(req.error);
      }
    };
  });
}

export async function deleteByPRKey(prKey: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const index = tx.objectStore(STORE_NAME).index("prKey");
    const req = index.openCursor(IDBKeyRange.only(prKey));

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clear(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
