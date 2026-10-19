import { expect, test } from "bun:test";
import type { PullRequestFile } from "@/api/types";
import { comparisonFileList, pairComparisonFiles } from "./comparison-files";

const file = (filename: string, overrides: Partial<PullRequestFile> = {}) =>
  ({ filename, status: "modified", ...overrides }) as PullRequestFile;

test("comparison includes reverted changes and files without patches", () => {
  const pairs = pairComparisonFiles(
    [file("reverted"), file("added", { status: "added" })],
    [file("binary")]
  );
  expect(pairs.map((p) => p.filename)).toEqual(["binary", "reverted", "added"]);
  expect(comparisonFileList(pairs).map((f) => f.status)).toEqual([
    "modified",
    "modified",
    "removed",
  ]);
});

test("renames match by original path while preserving exact matches and copies", () => {
  const old = file("old-name", {
    status: "renamed",
    previous_filename: "original",
  });
  const pairs = pairComparisonFiles(
    [old, file("source")],
    [
      file("new-name", { status: "renamed", previous_filename: "original" }),
      file("copy", { status: "copied", previous_filename: "source" }),
      file("source"),
    ]
  );
  expect(pairs).toHaveLength(3);
  expect(pairs[0]!.previous).toBe(old);
  expect(pairs[1]!.previous).toBeUndefined();
  expect(pairs[2]!.previous?.filename).toBe("source");
});
