import { expect, spyOn, test } from "bun:test";
import type { PullRequestFile } from "@/api/types";
import { diffService } from "@/browser/lib/diff";
import { fetchParsedDiff } from "./useDiffLoader";

test("diff cache isolates comparisons and filenames sharing a blob", async () => {
  const parse = spyOn(diffService, "parseDiff").mockImplementation(
    async () => ({
      hunks: [],
    })
  );
  const file = {
    filename: "cache-regression.ts",
    sha: "shared-blob",
    patch: "@@ -1 +1 @@\n-old\n+new",
  } as PullRequestFile;
  const content = async () => "content";
  try {
    const first = await fetchParsedDiff(
      file,
      undefined,
      content,
      "a",
      "h",
      "repo:a:h"
    );
    expect(
      await fetchParsedDiff(file, undefined, content, "a", "h", "repo:a:h")
    ).toBe(first);
    expect(
      await fetchParsedDiff(
        { ...file, patch: "@@ -1 +1 @@\n-other\n+new" },
        undefined,
        content,
        "b",
        "h",
        "repo:b:h"
      )
    ).not.toBe(first);
    expect(
      await fetchParsedDiff(
        { ...file, filename: "other.ts" },
        undefined,
        content,
        "a",
        "h",
        "repo:a:h"
      )
    ).not.toBe(first);
    expect(parse).toHaveBeenCalledTimes(3);
  } finally {
    parse.mockRestore();
  }
});
