import { test, expect } from "bun:test";
import {
  parseOutOfDiffMarker,
  buildOutOfDiffMarker,
  isOutOfDiffComment,
  stripOutOfDiffPermalink,
  stripOutOfDiffPermalinkHtml,
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

test("marker carries the anchor commit when provided", () => {
  const withSha = buildOutOfDiffMarker(415, 413, "RIGHT", "f9a1167bbc9e");
  expect(parseOutOfDiffMarker(withSha)).toEqual({
    line: 415,
    startLine: 413,
    side: "RIGHT",
    sha: "f9a1167bbc9e",
  });
  expect(isOutOfDiffComment(withSha)).toBe(true);
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

test("strips the trailing permalink from raw bodies", () => {
  const body =
    "another out-of-diff comment\n\nhttps://github.com/o/r/blob/f9a1167bbc9e3d2b6047566e61e4e1b1c44af8d8/src/a.ts#L18-L20";
  expect(stripOutOfDiffPermalink(body)).toBe("another out-of-diff comment");
});

test("strips the embedded snippet block from rendered HTML", () => {
  const html = [
    '<p dir="auto">another out-of-diff comment</p>',
    '<p dir="auto"></p><div class="Box Box--condensed my-2">',
    '  <div class="Box-header f6"><p class="mb-0 text-bold">x</p></div>',
    '  <div itemprop="text" class="Box-body p-0 blob-wrapper blob-wrapper-embedded data">',
    "    <table><tbody><tr><td>code</td></tr></tbody></table>",
    "  </div>",
    "</div>",
    "<p></p>",
  ].join("\n");
  expect(stripOutOfDiffPermalinkHtml(html)).toBe(
    '<p dir="auto">another out-of-diff comment</p>'
  );
});

test("leaves bodies without a permalink untouched", () => {
  expect(stripOutOfDiffPermalink("plain")).toBe("plain");
  expect(stripOutOfDiffPermalinkHtml("<p>plain</p>")).toBe("<p>plain</p>");
});
