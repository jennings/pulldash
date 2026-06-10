import { useEffect } from "react";
import type { PullRequestFile } from "@/api/types";
import { diffService } from "@/browser/lib/diff";
import { useGitHub } from "@/browser/contexts/github";
import { usePRReviewStore, usePRReviewSelector, type ParsedDiff } from ".";

const diffCache = new Map<string, ParsedDiff>();
const pendingFetches = new Map<
  string,
  { promise: Promise<ParsedDiff>; controller: AbortController }
>();
const MAX_CACHE_SIZE = 100;

// Check if a diff is already cached with full syntax highlighting (sync check)
function getFullDiffFromCache(
  file: PullRequestFile,
  cacheContext?: string
): ParsedDiff | null {
  if (!file.patch || !file.sha) {
    return { hunks: [] };
  }
  // Only return if we have the full content version with proper syntax highlighting
  const suffix = cacheContext ? `:${cacheContext}` : "";
  return diffCache.get(`${file.sha}:full${suffix}`) ?? null;
}

// Abort all pending fetches (used when navigating rapidly)
function abortAllPendingFetches() {
  for (const [key, { controller }] of pendingFetches) {
    controller.abort();
    pendingFetches.delete(key);
  }
}

/** Content getter function type for fetching file content */
type FileContentGetter = (path: string, ref: string) => Promise<string>;

async function fetchParsedDiff(
  file: PullRequestFile,
  signal?: AbortSignal,
  getFileContent?: FileContentGetter,
  baseRef?: string,
  headRef?: string,
  cacheContext?: string
): Promise<ParsedDiff> {
  if (!file.patch || !file.sha) {
    return { hunks: [] };
  }

  // Cache key includes whether we have file content (for better highlighting),
  // plus an optional context string to prevent collisions between full-branch
  // and per-commit views that share the same blob SHA.
  const hasContent = !!(getFileContent && baseRef && headRef);
  const suffix = cacheContext ? `:${cacheContext}` : "";
  const cacheKey = hasContent
    ? `${file.sha}:full${suffix}`
    : `${file.sha}${suffix}`;

  // Check cache first
  if (diffCache.has(cacheKey)) {
    return diffCache.get(cacheKey)!;
  }

  // Check if already aborted
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  // If there's already a pending fetch for this file, wait for it
  const existing = pendingFetches.get(cacheKey);
  if (existing) {
    // If caller wants to abort, wrap the promise
    if (signal) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort", onAbort);
        existing.promise
          .then(resolve)
          .catch(reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    }
    return existing.promise;
  }

  // Create new fetch with its own controller
  const controller = new AbortController();

  // Link to caller's signal
  if (signal) {
    signal.addEventListener("abort", () => controller.abort());
  }

  const fetchPromise = (async () => {
    let oldContent: string | undefined;
    let newContent: string | undefined;

    // Fetch file content for better syntax highlighting if getter is provided
    if (getFileContent && baseRef && headRef) {
      try {
        const [oldResult, newResult] = await Promise.all([
          // For deleted files or renames, use previous_filename for base
          file.status === "added"
            ? Promise.resolve("")
            : getFileContent(
                file.previous_filename || file.filename,
                baseRef
              ).catch(() => ""),
          // For deleted files, new content is empty
          file.status === "removed"
            ? Promise.resolve("")
            : getFileContent(file.filename, headRef).catch(() => ""),
        ]);
        oldContent = oldResult;
        newContent = newResult;
      } catch {
        // If fetching content fails, continue without it
      }
    }

    // Use WebWorker for diff parsing (off main thread)
    const parsed = await diffService.parseDiff(
      file.patch!,
      file.filename,
      file.previous_filename,
      oldContent,
      newContent
    );

    // Clean up pending entry
    pendingFetches.delete(cacheKey);

    if (!parsed.hunks) {
      return { hunks: [] };
    }

    // Add to cache
    if (diffCache.size >= MAX_CACHE_SIZE) {
      const firstKey = diffCache.keys().next().value;
      if (firstKey) diffCache.delete(firstKey);
    }
    diffCache.set(cacheKey, parsed);

    return parsed;
  })();

  pendingFetches.set(cacheKey, { promise: fetchPromise, controller });

  // Clean up on error
  fetchPromise.catch(() => {
    pendingFetches.delete(cacheKey);
  });

  return fetchPromise;
}

export function useDiffLoader() {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const files = usePRReviewSelector((s) => s.files);
  const loadedDiffs = usePRReviewSelector((s) => s.loadedDiffs);

  useEffect(() => {
    if (!selectedFile) return;

    const file = files.find((f) => f.filename === selectedFile);
    if (!file) return;

    const currentFile = selectedFile;
    // Commit-specific views use a distinct cache context so they don't collide
    // with full-branch diffs that share the same blob SHA.
    const cacheContext = selectedCommitSha ?? undefined;

    // Check cache synchronously - only use if we have full content version
    const cached = getFullDiffFromCache(file, cacheContext);
    if (cached) {
      if (!loadedDiffs[currentFile]) {
        store.setLoadedDiff(currentFile, cached);
      }
      return;
    }

    // Already loaded in store
    if (loadedDiffs[currentFile]) return;

    // Abort ALL pending fetches - only care about current file
    abortAllPendingFetches();

    // Start fetch immediately (no debounce - we have deduplication)
    // Show loading only if fetch takes > 50ms
    const loadingTimeoutId = setTimeout(() => {
      if (
        store.getSnapshot().selectedFile === currentFile &&
        !store.getSnapshot().loadedDiffs[currentFile]
      ) {
        store.setDiffLoading(currentFile, true);
      }
    }, 50);

    // Create file content getter for better syntax highlighting
    const getFileContent: FileContentGetter = (path, ref) =>
      github.getFileContent(owner, repo, path, ref);

    // Fetch immediately with full file content for better highlighting
    fetchParsedDiff(
      file,
      undefined,
      getFileContent,
      pr.base.sha,
      pr.head.sha,
      cacheContext
    )
      .then((diff) => {
        if (store.getSnapshot().selectedFile === currentFile) {
          store.setLoadedDiff(currentFile, diff);
          store.setDiffLoading(currentFile, false);

          // Prefetch next files aggressively (5 ahead, 2 behind)
          // Fetch with full file content for instant switching with proper highlighting
          const currentIndex = files.findIndex(
            (f) => f.filename === currentFile
          );
          const filesToPrefetch = [
            ...files.slice(Math.max(0, currentIndex - 2), currentIndex),
            ...files.slice(currentIndex + 1, currentIndex + 6),
          ].filter(
            (f) =>
              !store.getSnapshot().loadedDiffs[f.filename] &&
              !getFullDiffFromCache(f, cacheContext)
          );

          // Prefetch with full file content for proper syntax highlighting
          // Write to store for instant switching
          Promise.all(
            filesToPrefetch.map((pfile) =>
              fetchParsedDiff(
                pfile,
                undefined,
                getFileContent,
                pr.base.sha,
                pr.head.sha,
                cacheContext
              )
                .then((pdiff) => store.setLoadedDiff(pfile.filename, pdiff))
                .catch(() => {})
            )
          );
        }
      })
      .catch((err) => {
        if (
          err?.name !== "AbortError" &&
          store.getSnapshot().selectedFile === currentFile
        ) {
          console.error(err);
          store.setDiffLoading(currentFile, false);
        }
      });

    // Cleanup: cancel loading timeout
    return () => {
      clearTimeout(loadingTimeoutId);
      store.setDiffLoading(currentFile, false);
    };
  // NOTE: selectedCommitSha is intentionally omitted from deps. setSelectedCommitSha
  // does two sequential this.set() calls separated by an await: first it sets
  // selectedCommitSha (+ clears loadedDiffs), then after getCommitFiles resolves it
  // sets the new files. Adding selectedCommitSha here would fire this effect during
  // that intermediate window when files still holds the previous view's patches,
  // causing those stale patches to be parsed and cached under the new commit key.
  // The files dep is sufficient: by the time files updates, selectedCommitSha is
  // already in place, so cacheContext is correct when this effect body runs.
  }, [
    selectedFile,
    files,
    loadedDiffs,
    store,
    github,
    owner,
    repo,
    pr.base.sha,
    pr.head.sha,
  ]);
}
