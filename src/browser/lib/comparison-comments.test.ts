import { expect, test } from "bun:test";
import {
  comparisonCommentSide,
  comparisonCommentTarget,
} from "./comparison-comments";
import type { ParsedDiff } from "./diff-parser";

const diff: ParsedDiff = {
  hunks: [],
  sources: {
    old: { sha: "old", path: "before.ts" },
    new: { sha: "new", path: "after.ts" },
  },
};

test("both interdiff sides target the corresponding commit post-image", () => {
  expect(comparisonCommentTarget(diff, "old")).toEqual({
    path: "before.ts",
    targetSha: "old",
    side: "RIGHT",
  });
  expect(comparisonCommentTarget(diff, "new")).toEqual({
    path: "after.ts",
    targetSha: "new",
    side: "RIGHT",
  });
  expect(comparisonCommentSide(diff, "before.ts", "old", "RIGHT")).toBe("LEFT");
  expect(comparisonCommentSide(diff, "after.ts", "new", "RIGHT")).toBe("RIGHT");
  expect(comparisonCommentSide(diff, "after.ts", "new", "LEFT")).toBeNull();
  expect(
    comparisonCommentSide(diff, "before.ts", "unrelated", "RIGHT")
  ).toBeNull();
});
