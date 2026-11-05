import { expect, test } from "bun:test";
import { locateTextRange, renderedLineSide } from "./rendered-lines";

test("renderedLineSide: unified deletions are old-side, everything else new", () => {
  expect(renderedLineSide("unified", "change-deletion")).toBe("old");
  expect(renderedLineSide("unified", "change-addition")).toBe("new");
  expect(renderedLineSide("unified", "context")).toBe("new");
  expect(renderedLineSide("unified", undefined)).toBe("new");
  expect(renderedLineSide("deletions", "context")).toBe("old");
  expect(renderedLineSide("additions", "change-addition")).toBe("new");
});

test("locateTextRange maps character offsets onto text nodes", () => {
  // "const " + "answer" + " = 42" as three syntax-highlighted nodes
  const lengths = [6, 6, 5];
  expect(locateTextRange(lengths, 6, 12)).toEqual({
    startNode: 1,
    startOffset: 0,
    endNode: 1,
    endOffset: 6,
  });
  expect(locateTextRange(lengths, 4, 9)).toEqual({
    startNode: 0,
    startOffset: 4,
    endNode: 1,
    endOffset: 3,
  });
  expect(locateTextRange(lengths, 15, 17)).toEqual({
    startNode: 2,
    startOffset: 3,
    endNode: 2,
    endOffset: 5,
  });
  // Empty or out-of-range spans have nothing to paint; overlong ones clamp.
  expect(locateTextRange(lengths, 3, 3)).toBeNull();
  expect(locateTextRange(lengths, 17, 20)).toBeNull();
  expect(locateTextRange(lengths, 15, 40)?.endOffset).toBe(5);
  expect(locateTextRange([], 0, 1)).toBeNull();
});
