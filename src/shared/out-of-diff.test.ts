import { test, expect } from "bun:test";
import {
  parseOutOfDiffMarker,
  buildOutOfDiffMarker,
  isOutOfDiffComment,
} from "./out-of-diff";

test("marker round-trips with and without a start line", () => {
  const single = buildOutOfDiffMarker(415, undefined, "RIGHT");
  expect(parseOutOfDiffMarker(single)).toEqual({
    line: 415,
    startLine: undefined,
    side: "RIGHT",
  });

  const range = buildOutOfDiffMarker(415, 413, "LEFT");
  expect(parseOutOfDiffMarker(range)).toEqual({
    line: 415,
    startLine: 413,
    side: "LEFT",
  });
});

test("detects the marker anywhere in the body", () => {
  expect(
    isOutOfDiffComment("x\n<!-- pulldash:out-of-diff line=5 side=LEFT -->\ny")
  ).toBe(true);
  expect(isOutOfDiffComment("plain body")).toBe(false);
  expect(isOutOfDiffComment(undefined)).toBe(false);
});

test("returns null for other pulldash markers or malformed ones", () => {
  expect(
    parseOutOfDiffMarker("<!-- pulldash:commit-metadata sha=x line=1 -->")
  ).toBeNull();
  expect(parseOutOfDiffMarker("<!-- pulldash:out-of-diff -->")).toBeNull();
});
