import { test, expect } from "bun:test";
import { splitHighlightedHtml } from "./diff-utils";

test("splitHighlightedHtml re-opens enclosing tags in each piece", () => {
  expect(
    splitHighlightedHtml('<span class="token comment">| a&lt;b</span>', [2, 3])
  ).toEqual([
    '<span class="token comment">| </span>',
    '<span class="token comment">a&lt;b</span>',
  ]);
});

test("splitHighlightedHtml handles nested tags and tag boundaries", () => {
  expect(
    splitHighlightedHtml(
      '<span class="a">x<span class="b">y</span></span>z',
      [1, 2]
    )
  ).toEqual([
    '<span class="a">x</span>',
    '<span class="a"><span class="b">y</span></span>z',
  ]);
});

test("splitHighlightedHtml rejects mismatched lengths", () => {
  expect(splitHighlightedHtml("<span>abc</span>", [1, 1])).toBeNull();
  expect(splitHighlightedHtml("<span>abc</span>", [2, 2])).toBeNull();
});
