import { expect, test } from "bun:test";
import { groupMatchesByLine, isSameMatch, lineKey } from "./search-highlight";

const match = (side: "old" | "new", lineNumber: number, start: number) => ({
  side,
  lineNumber,
  start,
  end: start + 3,
});

test("groupMatchesByLine groups by side and line and keeps match order", () => {
  const grouped = groupMatchesByLine([
    match("new", 4, 0),
    match("old", 4, 2),
    match("new", 4, 9),
    match("new", 7, 1),
  ]);
  expect([...grouped.keys()]).toEqual(["new:4", "old:4", "new:7"]);
  expect(grouped.get(lineKey("new", 4))?.map((m) => m.start)).toEqual([0, 9]);
});

test("isSameMatch compares position, not identity", () => {
  expect(isSameMatch(match("new", 4, 2), match("new", 4, 2))).toBe(true);
  expect(isSameMatch(match("new", 4, 2), match("old", 4, 2))).toBe(false);
  expect(isSameMatch(match("new", 4, 2), match("new", 4, 3))).toBe(false);
  expect(isSameMatch(null, match("new", 4, 2))).toBe(false);
});
