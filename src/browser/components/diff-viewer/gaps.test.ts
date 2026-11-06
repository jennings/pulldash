import { expect, test } from "bun:test";
import { diffRows, fileDiffFromPatch, type DiffRow } from "../../lib/file-diff";
import {
  findGap,
  findGapHiding,
  hasVisibleLine,
  lineNextToGap,
  sameExpansion,
  type GapRow,
} from "./gaps";

const patch = [
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  " c",
  "@@ -20,3 +20,3 @@",
  " x",
  "-y",
  "+Y",
  " z",
].join("\n");

const rows: DiffRow[] = diffRows(
  fileDiffFromPatch({ patch, filename: "f.ts" })
);
const gap = rows.find((row): row is GapRow => row.kind === "gap");

test("a collapsed gap hides the lines between hunks on each side", () => {
  expect(gap).toMatchObject({
    hunkIndex: 1,
    count: 16,
    oldStart: 4,
    newStart: 4,
  });
  expect(hasVisibleLine(rows, "new", 2)).toBe(true);
  expect(hasVisibleLine(rows, "old", 2)).toBe(true);
  expect(hasVisibleLine(rows, "new", 10)).toBe(false);
  expect(findGapHiding(rows, "new", 10)).toBe(gap!);
  expect(findGapHiding(rows, "old", 19)).toBe(gap!);
  expect(findGapHiding(rows, "new", 20)).toBeNull();
  expect(findGapHiding(rows, "new", 3)).toBeNull();
  expect(findGap(rows, 1)).toBe(gap!);
  expect(findGap(rows, 0)).toBeNull();
});

test("lineNextToGap picks the first line after the gap, else the last before it", () => {
  expect(lineNextToGap(rows, gap!)).toEqual({
    lineNumber: 20,
    side: "additions",
  });
  const trailing: DiffRow[] = [
    ...rows.slice(0, 3),
    { kind: "gap", hunkIndex: 1, count: 9, oldStart: 4, newStart: 4 },
  ];
  expect(lineNextToGap(trailing, trailing[3] as GapRow)).toEqual({
    lineNumber: 2,
    side: "additions",
  });
  expect(lineNextToGap(rows, { ...gap!, count: 1 })).toBeNull();
});

test("sameExpansion compares regions, not map identity", () => {
  const region = { fromStart: 3, fromEnd: 0 };
  expect(sameExpansion(new Map(), new Map())).toBe(true);
  expect(
    sameExpansion(new Map([[1, region]]), new Map([[1, { ...region }]]))
  ).toBe(true);
  expect(sameExpansion(new Map([[1, region]]), new Map())).toBe(false);
  expect(
    sameExpansion(
      new Map([[1, region]]),
      new Map([[1, { fromStart: 3, fromEnd: 1 }]])
    )
  ).toBe(false);
  expect(sameExpansion(new Map([[1, region]]), new Map([[2, region]]))).toBe(
    false
  );
});
