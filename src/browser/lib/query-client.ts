import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

// Separate DB from PersistentCache (pulldash/responses) to avoid collisions
const DB_NAME = "pulldash-rq";
const STORE_NAME = "data";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
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

const idbStorage = {
  getItem: async (key: string): Promise<string | null> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  },
  setItem: async (key: string, value: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
  removeItem: async (key: string): Promise<void> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  },
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: ({ meta }) => meta?.immutable !== true,
      retry: 1,
    },
  },
});

export const persister = createAsyncStoragePersister({
  storage: idbStorage,
});
