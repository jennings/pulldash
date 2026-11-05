import { useEffect, useMemo } from "react";
import type { FileContents, FileDiffContentsLoader } from "@pierre/diffs";
import type { PullRequestFile } from "@/api/types";
import { useGitHub, type PRCommit } from "@/browser/contexts/github";
import {
  comparisonContentsProblem,
  emptyLoadedDiff,
  fileDiffFromPatch,
  hashText,
  reconstructPreImage,
  type LoadedDiff,
} from "@/browser/lib/file-diff";
import { usePRReviewStore, usePRReviewSelector, getLoadedFileDiff } from ".";

type RawDiffGetter = (baseSha: string, headSha: string) => Promise<string>;

const diffCache = new Map<string, LoadedDiff>();
const pendingFetches = new Map<string, Promise<LoadedDiff>>();
const MAX_CACHE_SIZE = 100;

/** The refs the displayed file diffs are computed between. */
export interface DiffRefs {
  baseRef: string;
  headRef: string;
}

/**
 * Base and head of the diff being viewed: the PR's range (or the selected
 * push version's), or the selected commit against its parent.
 */
export function resolveDiffRefs(state: {
  pr: { base: { sha: string }; head: { sha: string } };
  selectedHeadSha: string | null;
  selectedCommitSha: string | null;
  selectedParentSha: string | null;
  commits: readonly PRCommit[];
  commitsByVersion: ReadonlyArray<{ commits: readonly PRCommit[] }>;
}): DiffRefs {
  let baseRef = state.pr.base.sha;
  let headRef = state.selectedHeadSha ?? state.pr.head.sha;
  if (state.selectedCommitSha) {
    const commits = [
      ...state.commits,
      ...state.commitsByVersion.flatMap((version) => version.commits),
    ];
    baseRef =
      state.selectedParentSha ??
      commits.find((commit) => commit.sha === state.selectedCommitSha)
        ?.parents?.[0]?.sha ??
      baseRef;
    headRef = state.selectedCommitSha;
  }
  return { baseRef, headRef };
}

/** Cache identity of a file's diff: where it was computed and what it says. */
function diffKey(file: PullRequestFile, cacheContext: string): string {
  return [
    cacheContext,
    file.filename,
    file.sha,
    file.patch ? hashText(file.patch) : "omitted",
  ].join("\n");
}

function remember(key: string, diff: LoadedDiff): LoadedDiff {
  if (diffCache.size >= MAX_CACHE_SIZE) {
    const firstKey = diffCache.keys().next().value;
    if (firstKey !== undefined) diffCache.delete(firstKey);
  }
  diffCache.set(key, diff);
  return diff;
}

function buildLoadedDiff(
  file: PullRequestFile,
  patch: string,
  cacheContext: string
): LoadedDiff {
  return {
    fileDiff: fileDiffFromPatch({
      patch,
      filename: file.filename,
      previousFilename: file.previous_filename,
      status: file.status,
      // Pierre keys its highlight cache on this: it must change with the
      // content, and the hydrated (full-file) state depends on the refs too.
      cacheKey: `${hashText(cacheContext)}:${file.sha}:${hashText(file.filename + "\n" + patch)}`,
    }),
  };
}

/**
 * The file's diff if it can be had without fetching anything: cached, or built
 * from the patch GitHub returned. Null when the patch was omitted and has to
 * be recovered first (see `fetchLoadedDiff`).
 */
export function getLoadedDiffNow(
  file: PullRequestFile,
  cacheContext: string
): LoadedDiff | null {
  const key = diffKey(file, cacheContext);
  const cached = diffCache.get(key);
  if (cached) return cached;
  if (!file.patch) return null;
  return remember(key, buildLoadedDiff(file, file.patch, cacheContext));
}

/** Check if a file's diff is already available (sync check). */
export function getCachedLoadedDiff(
  file: PullRequestFile,
  cacheContext: string
): LoadedDiff | null {
  return diffCache.get(diffKey(file, cacheContext)) ?? null;
}

/** Extract a file's hunks from a raw unified diff string, or null if not found.
 * Returns just the hunk content (starting from first @@) — the diff model
 * synthesizes the diff --git / --- / +++ header itself. */
export function extractFilePatch(
  rawDiff: string,
  filename: string,
  status: string,
  previousFilename?: string | null
): string | null {
  const fileA =
    status === "added" ? "/dev/null" : `a/${previousFilename || filename}`;
  const fileB = status === "removed" ? "/dev/null" : `b/${filename}`;
  const startMarker = `diff --git ${fileA} ${fileB}`;

  let startIdx = rawDiff.indexOf(startMarker);
  if (startIdx === -1) {
    // For renames, the diff --git line uses old and new paths
    const renameMarker = `diff --git a/${previousFilename || filename} b/${filename}`;
    startIdx = rawDiff.indexOf(renameMarker);
    if (startIdx === -1) return null;
  }

  // Find the end of this file's section (next diff --git or end of string)
  const endIdx = rawDiff.indexOf("\ndiff --git ", startIdx + 1);
  const section =
    endIdx === -1 ? rawDiff.slice(startIdx) : rawDiff.slice(startIdx, endIdx);

  // Find the first hunk header (@@ ... @@) — skip everything before it
  // (diff --git, index, ---/+++ lines — the diff model adds these itself)
  const hunkStart = section.indexOf("@@");
  if (hunkStart === -1) return null;
  return section.slice(hunkStart);
}

export async function fetchLoadedDiff(
  file: PullRequestFile,
  options: {
    signal?: AbortSignal;
    baseRef?: string;
    headRef?: string;
    cacheContext?: string;
    getRawDiff?: RawDiffGetter;
  } = {}
): Promise<LoadedDiff> {
  const { signal, baseRef, headRef, getRawDiff } = options;
  const cacheContext = options.cacheContext ?? "";
  const aborted = () => new DOMException("Aborted", "AbortError");
  if (signal?.aborted) throw aborted();

  const now = getLoadedDiffNow(file, cacheContext);
  if (now) return now;

  const key = diffKey(file, cacheContext);
  if (!getRawDiff || !baseRef || !headRef) {
    // Nothing to recover the omitted patch from.
    return emptyLoadedDiff(file.filename);
  }

  // The patch was omitted (too large or binary). Try to recover it from the
  // raw unified diff of the entire base..head range.
  let pending = pendingFetches.get(key);
  if (!pending) {
    pending = (async () => {
      let rawDiff: string;
      try {
        rawDiff = await getRawDiff(baseRef, headRef);
      } catch {
        // Not cached, so a later load retries.
        return emptyLoadedDiff(file.filename);
      }
      const patch = extractFilePatch(
        rawDiff,
        file.filename,
        file.status,
        file.previous_filename
      );
      return remember(
        key,
        patch
          ? buildLoadedDiff(file, patch, cacheContext)
          : emptyLoadedDiff(file.filename)
      );
    })().finally(() => pendingFetches.delete(key));
    pendingFetches.set(key, pending);
  }
  const diff = await pending;
  if (signal?.aborted) throw aborted();
  return diff;
}

/** Forget everything fetched so far (tests, account switches). */
export function clearLoadedDiffCache() {
  diffCache.clear();
  pendingFetches.clear();
}

/**
 * Loads the selected file's diff into the store. Patches come with the file
 * list, so this is synchronous unless GitHub omitted one: then it is recovered
 * from the raw range diff, and the same is done ahead of time for the files
 * around the selection.
 */
export function useDiffLoader() {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const files = usePRReviewSelector((s) => s.files);
  const loadedDiffs = usePRReviewSelector((s) => s.loadedDiffs);

  useEffect(() => {
    if (!selectedFile) return;

    const file = files.find((f) => f.filename === selectedFile);
    if (!file) return;

    const currentFile = selectedFile;
    const { baseRef, headRef } = resolveDiffRefs({
      ...store.getSnapshot(),
      pr,
    });
    const cacheContext = JSON.stringify([owner, repo, baseRef, headRef]);

    // Already loaded in store
    if (loadedDiffs[currentFile]) return;

    const available = getLoadedDiffNow(file, cacheContext);
    if (available) {
      store.setLoadedDiff(currentFile, available);
      return;
    }

    let active = true;

    // Show loading only if the fetch takes > 50ms
    const loadingTimeoutId = setTimeout(() => {
      if (
        store.getSnapshot().selectedFile === currentFile &&
        !store.getSnapshot().loadedDiffs[currentFile]
      ) {
        store.setDiffLoading(currentFile, true);
      }
    }, 50);

    const prKey = `${owner}/${repo}/${pr.number}`;
    // Raw diff getter for recovering patches omitted by the JSON API
    const getRawDiff: RawDiffGetter = (base, head) =>
      github.getRawCompareDiff(owner, repo, base, head, prKey);
    const fetchOptions = { baseRef, headRef, cacheContext, getRawDiff };

    fetchLoadedDiff(file, fetchOptions)
      .then((diff) => {
        if (active && store.getSnapshot().selectedFile === currentFile) {
          store.setLoadedDiff(currentFile, diff);
          store.setDiffLoading(currentFile, false);

          // Recover omitted patches of the neighboring files (2 behind, 5
          // ahead) so switching to them is instant.
          const currentIndex = files.findIndex(
            (f) => f.filename === currentFile
          );
          const neighbors = [
            ...files.slice(Math.max(0, currentIndex - 2), currentIndex),
            ...files.slice(currentIndex + 1, currentIndex + 6),
          ].filter(
            (f) =>
              !f.patch &&
              !store.getSnapshot().loadedDiffs[f.filename] &&
              !getCachedLoadedDiff(f, cacheContext)
          );
          for (const neighbor of neighbors) {
            fetchLoadedDiff(neighbor, fetchOptions)
              .then((prefetched) => {
                if (active) store.setLoadedDiff(neighbor.filename, prefetched);
              })
              .catch(() => {});
          }
        }
      })
      .catch((err) => {
        if (
          err?.name !== "AbortError" &&
          active &&
          store.getSnapshot().selectedFile === currentFile
        ) {
          console.error(err);
          store.setDiffLoading(currentFile, false);
        }
      });

    // Cleanup: cancel loading timeout
    return () => {
      active = false;
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

/**
 * Where to fetch the two sides of `filename`'s diff from, as Pierre's
 * `loadDiffFiles` hook (called when the user expands hidden context). For
 * PR and commit diffs only the post-image is fetched (at the ref the patch
 * was computed for) and the pre-image is rebuilt from it and the patch. For
 * a comparison both versions are fetched. The loader throws, so Pierre keeps
 * the partial diff, when the fetched text does not fit the hunks. Undefined
 * when the diff cannot be expanded: it is not a file of the PR (the `:commit`
 * metadata) or is not loaded as a comparison yet. The loader is stable until
 * the diff's refs change.
 */
export function useDiffFilesLoader(
  filename: string | null
): FileDiffContentsLoader | undefined {
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const prNumber = usePRReviewSelector((s) => s.pr.number);
  const baseSha = usePRReviewSelector((s) => s.pr.base.sha);
  const headSha = usePRReviewSelector((s) => s.pr.head.sha);
  const selectedHeadSha = usePRReviewSelector((s) => s.selectedHeadSha);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const selectedParentSha = usePRReviewSelector((s) => s.selectedParentSha);
  const commits = usePRReviewSelector((s) => s.commits);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  const interdiffEnabled = usePRReviewSelector((s) => s.interdiffEnabled);
  const sources = usePRReviewSelector(
    (s) => getLoadedFileDiff(s, filename)?.sources ?? null
  );

  const { headRef } = useMemo(
    () =>
      resolveDiffRefs({
        pr: { base: { sha: baseSha }, head: { sha: headSha } },
        selectedHeadSha,
        selectedCommitSha,
        selectedParentSha,
        commits,
        commitsByVersion,
      }),
    [
      baseSha,
      headSha,
      selectedHeadSha,
      selectedCommitSha,
      selectedParentSha,
      commits,
      commitsByVersion,
    ]
  );

  const oldSource = sources?.old;
  const newSource = sources?.new;
  return useMemo(() => {
    if (!filename || filename === ":commit") return undefined;
    const prKey = `${owner}/${repo}/${prNumber}`;
    const fetchSide = async (
      path: string,
      ref: string
    ): Promise<FileContents> => ({
      name: path,
      contents: await github.getFileContent(owner, repo, path, ref, prKey),
      cacheKey: `${path}@${ref}`,
    });
    /** PR and commit-range diffs: only the post-image is fetched. */
    const loadPostImage = async (
      fileDiff: Parameters<FileDiffContentsLoader>[0]
    ) => {
      const newFile = await fetchSide(fileDiff.name, headRef);
      if (fileDiff.type === "rename-pure") return { oldFile: null, newFile };
      if (fileDiff.type !== "change" && fileDiff.type !== "rename-changed") {
        throw new Error(`Cannot load the contents of a ${fileDiff.type} file`);
      }
      // The patch was computed against the merge base's file, which no ref
      // we know of points at: rebuild it by undoing the hunks instead.
      const oldContents = reconstructPreImage(fileDiff, newFile.contents);
      if (oldContents === null) {
        throw new Error(
          `${fileDiff.name} at ${headRef} does not match its diff; not expanding`
        );
      }
      const oldPath = fileDiff.prevName ?? fileDiff.name;
      return {
        oldFile: {
          name: oldPath,
          contents: oldContents,
          cacheKey: `${oldPath}@${headRef}:pre-image`,
        },
        newFile,
      };
    };

    /** Comparisons: both versions are fetched and must fit the hunks. */
    const loadVersions = async (
      fileDiff: Parameters<FileDiffContentsLoader>[0],
      oldSide: { path: string; ref: string },
      newSide: { path: string; ref: string }
    ) => {
      if (fileDiff.type !== "change" && fileDiff.type !== "rename-changed") {
        throw new Error(`Cannot load the contents of a ${fileDiff.type} file`);
      }
      const [oldFile, newFile] = await Promise.all([
        fetchSide(oldSide.path, oldSide.ref),
        fetchSide(newSide.path, newSide.ref),
      ]);
      const problem = comparisonContentsProblem(
        fileDiff,
        oldFile.contents,
        newFile.contents
      );
      if (problem) {
        throw new Error(`Not expanding ${fileDiff.name}: ${problem}`);
      }
      return { oldFile, newFile };
    };

    if (oldSource && newSource) {
      return (fileDiff) =>
        loadVersions(
          fileDiff,
          { path: oldSource.path, ref: oldSource.sha },
          { path: newSource.path, ref: newSource.sha }
        );
    }
    if (interdiffEnabled) return undefined;
    return loadPostImage;
  }, [
    filename,
    github,
    owner,
    repo,
    prNumber,
    headRef,
    interdiffEnabled,
    oldSource?.path,
    oldSource?.sha,
    newSource?.path,
    newSource?.sha,
  ]);
}
