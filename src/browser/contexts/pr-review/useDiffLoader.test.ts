import { beforeEach, expect, test } from "bun:test";
import type { PullRequestFile } from "@/api/types";
import type { PRCommit } from "@/browser/contexts/github";
import {
  clearLoadedDiffCache,
  extractFilePatch,
  fetchLoadedDiff,
  getCachedLoadedDiff,
  getLoadedDiffNow,
  resolveDiffRefs,
} from "./useDiffLoader";

beforeEach(clearLoadedDiffCache);

const PATCH = "@@ -1 +1 @@\n-old\n+new";
const file = (extra: Partial<PullRequestFile> = {}) =>
  ({
    filename: "cache-regression.ts",
    status: "modified",
    sha: "shared-blob",
    patch: PATCH,
    ...extra,
  }) as PullRequestFile;

test("diff cache isolates comparisons and filenames sharing a blob", async () => {
  const first = await fetchLoadedDiff(file(), { cacheContext: "repo:a:h" });
  expect(await fetchLoadedDiff(file(), { cacheContext: "repo:a:h" })).toBe(
    first
  );
  // A different base: the same patch is a different diff.
  const otherBase = await fetchLoadedDiff(file(), { cacheContext: "repo:b:h" });
  expect(otherBase).not.toBe(first);
  // Different content under the same blob.
  expect(
    await fetchLoadedDiff(file({ patch: "@@ -1 +1 @@\n-other\n+new" }), {
      cacheContext: "repo:a:h",
    })
  ).not.toBe(first);
  expect(
    await fetchLoadedDiff(file({ filename: "other.ts" }), {
      cacheContext: "repo:a:h",
    })
  ).not.toBe(first);
});

test("pierre's cache key is short and tells apart contexts, blobs and content", () => {
  const big =
    "@@ -1,500 +1,1 @@\n" + "-a long line of code\n".repeat(500) + "+x";
  const keys = [
    getLoadedDiffNow(file({ patch: big }), "ctx-a")!.fileDiff.cacheKey!,
    getLoadedDiffNow(file({ patch: big }), "ctx-b")!.fileDiff.cacheKey!,
    getLoadedDiffNow(file({ patch: big, sha: "blob-2" }), "ctx-a")!.fileDiff
      .cacheKey!,
    getLoadedDiffNow(file({ patch: big + "y" }), "ctx-a")!.fileDiff.cacheKey!,
    getLoadedDiffNow(file({ patch: big, filename: "b.ts" }), "ctx-a")!.fileDiff
      .cacheKey!,
  ];
  expect(new Set(keys).size).toBe(keys.length);
  for (const key of keys) expect(key.length).toBeLessThan(80);
});

test("a diff is built from the patch, status and previous name", () => {
  const renamed = getLoadedDiffNow(
    file({
      filename: "new-name.ts",
      previous_filename: "old-name.ts",
      status: "renamed",
    }),
    "ctx"
  )!;
  expect(renamed.fileDiff.type).toBe("rename-changed");
  expect(renamed.fileDiff.prevName).toBe("old-name.ts");
  expect(renamed.fileDiff.hunks).toHaveLength(1);
  expect(renamed.error).toBeUndefined();
});

test("an omitted patch is not available without fetching", async () => {
  const omitted = file({ patch: undefined });
  expect(getLoadedDiffNow(omitted, "ctx")).toBeNull();
  expect(getCachedLoadedDiff(omitted, "ctx")).toBeNull();
  // Without a raw-diff getter there is nothing to recover from.
  const empty = await fetchLoadedDiff(omitted, { cacheContext: "ctx" });
  expect(empty.fileDiff.hunks).toEqual([]);
});

const RAW_DIFF = [
  "diff --git a/other.ts b/other.ts",
  "index 111..222 100644",
  "--- a/other.ts",
  "+++ b/other.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "diff --git a/cache-regression.ts b/cache-regression.ts",
  "index 333..444 100644",
  "--- a/cache-regression.ts",
  "+++ b/cache-regression.ts",
  "@@ -3,2 +3,2 @@ fn",
  " keep",
  "-before",
  "+after",
].join("\n");

test("an omitted patch is recovered from the raw range diff once, even concurrently", async () => {
  let calls = 0;
  const getRawDiff = async (base: string, head: string) => {
    calls++;
    expect([base, head]).toEqual(["b", "h"]);
    return RAW_DIFF;
  };
  const options = {
    baseRef: "b",
    headRef: "h",
    cacheContext: "ctx",
    getRawDiff,
  };
  const omitted = file({ patch: undefined });
  const [first, second] = await Promise.all([
    fetchLoadedDiff(omitted, options),
    fetchLoadedDiff(omitted, options),
  ]);
  expect(first).toBe(second);
  expect(calls).toBe(1);
  expect(first.fileDiff.hunks).toHaveLength(1);
  expect(first.fileDiff.hunks[0]).toMatchObject({
    additionStart: 3,
    hunkContext: "fn",
  });
  // Now cached for synchronous use.
  expect(getCachedLoadedDiff(omitted, "ctx")).toBe(first);
  expect(getLoadedDiffNow(omitted, "ctx")).toBe(first);
  await fetchLoadedDiff(omitted, options);
  expect(calls).toBe(1);
});

test("a failed recovery gives an empty diff that is not cached, so a retry recovers", async () => {
  const omitted = file({ patch: undefined });
  const options = { baseRef: "b", headRef: "h", cacheContext: "ctx" };
  const diff = await fetchLoadedDiff(omitted, {
    ...options,
    getRawDiff: async () => {
      throw new Error("offline");
    },
  });
  expect(diff.fileDiff.hunks).toEqual([]);
  expect(getCachedLoadedDiff(omitted, "ctx")).toBeNull();
  const retried = await fetchLoadedDiff(omitted, {
    ...options,
    getRawDiff: async () => RAW_DIFF,
  });
  expect(retried.fileDiff.hunks).toHaveLength(1);
});

test("a raw diff without the file is cached as empty", async () => {
  let calls = 0;
  const options = {
    baseRef: "b",
    headRef: "h",
    cacheContext: "ctx",
    getRawDiff: async () => {
      calls++;
      return "diff --git a/unrelated b/unrelated\n@@ -1 +1 @@\n-a\n+b";
    },
  };
  const omitted = file({ patch: undefined });
  const first = await fetchLoadedDiff(omitted, options);
  expect(first.fileDiff.hunks).toEqual([]);
  expect(await fetchLoadedDiff(omitted, options)).toBe(first);
  expect(calls).toBe(1);
});

test("an aborted fetch rejects", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchLoadedDiff(file(), { signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("extractFilePatch finds renamed files and returns only hunks", () => {
  const raw = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 80%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
  ].join("\n");
  expect(extractFilePatch(raw, "new.ts", "renamed", "old.ts")).toBe(
    "@@ -1 +1 @@\n-a\n+b"
  );
  expect(extractFilePatch(raw, "missing.ts", "modified")).toBeNull();
});

test("diff refs: PR range, push version, and a commit against its parent", () => {
  const commit = (sha: string, parent: string) =>
    ({ sha, parents: [{ sha: parent }] }) as PRCommit;
  const base = {
    pr: { base: { sha: "base" }, head: { sha: "head" } },
    selectedHeadSha: null,
    selectedCommitSha: null,
    selectedParentSha: null,
    commits: [commit("c2", "c1")],
    commitsByVersion: [{ commits: [commit("old", "oldparent")] }],
  };
  expect(resolveDiffRefs(base)).toEqual({ baseRef: "base", headRef: "head" });
  expect(resolveDiffRefs({ ...base, selectedHeadSha: "v1" })).toEqual({
    baseRef: "base",
    headRef: "v1",
  });
  expect(resolveDiffRefs({ ...base, selectedCommitSha: "c2" })).toEqual({
    baseRef: "c1",
    headRef: "c2",
  });
  expect(resolveDiffRefs({ ...base, selectedCommitSha: "old" })).toEqual({
    baseRef: "oldparent",
    headRef: "old",
  });
  expect(
    resolveDiffRefs({
      ...base,
      selectedCommitSha: "c2",
      selectedParentSha: "other",
    })
  ).toEqual({ baseRef: "other", headRef: "c2" });
  // A commit nobody knows the parent of falls back to the PR base.
  expect(resolveDiffRefs({ ...base, selectedCommitSha: "unknown" })).toEqual({
    baseRef: "base",
    headRef: "unknown",
  });
});
