import { expect, test } from "bun:test";
import { getReplyText } from "./comment-reply";

const start = {} as Node;
const end = {} as Node;
const outside = {} as Node;
const button = {
  closest: (selector: string) =>
    selector === "[data-comment]"
      ? {
          querySelector: (selector: string) =>
            selector === "[data-comment-body]"
              ? { contains: (node: Node) => node === start || node === end }
              : null,
        }
      : null,
} as unknown as Element;

function selection(overrides: Partial<Selection> = {}): Selection {
  return {
    isCollapsed: false,
    anchorNode: start,
    focusNode: end,
    toString: () => "Selected text\nacross paragraphs",
    ...overrides,
  } as Selection;
}

test("reply uses selected text within the comment body in either selection direction", () => {
  expect(getReplyText("Full **Markdown** comment", button, selection())).toBe(
    "Selected text\nacross paragraphs"
  );
  expect(
    getReplyText(
      "Full comment",
      button,
      selection({ anchorNode: end, focusNode: start })
    )
  ).toBe("Selected text\nacross paragraphs");
});

test("reply keeps the original Markdown without a nonempty selection inside this comment", () => {
  const body = "Full **Markdown** comment";
  for (const selected of [
    null,
    selection({ isCollapsed: true }),
    selection({ toString: () => " \n " }),
    selection({ anchorNode: outside, focusNode: outside }),
    selection({ anchorNode: outside }),
    selection({ focusNode: outside }),
    selection({ anchorNode: null }),
  ]) {
    expect(getReplyText(body, button, selected)).toBe(body);
  }
  expect(
    getReplyText(
      body,
      { closest: () => null } as unknown as Element,
      selection()
    )
  ).toBe(body);
});
