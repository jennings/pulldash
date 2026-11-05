import { test, expect, describe } from "bun:test";
import type { RootContent } from "hast";
import { escapeHtml, hastToHtml } from "./html";

describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  test("escapes less-than and greater-than", () => {
    expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  test("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#039;s");
  });

  test("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("escapes multiple special chars in one string", () => {
    expect(escapeHtml('<a href="x&y">z</a>')).toBe(
      "&lt;a href=&quot;x&amp;y&quot;&gt;z&lt;/a&gt;"
    );
  });
});

describe("hastToHtml", () => {
  test("converts text node to escaped html", () => {
    const node: RootContent = { type: "text", value: "hello & world" };
    expect(hastToHtml(node)).toBe("hello &amp; world");
  });

  test("converts element node with no class", () => {
    const node: RootContent = {
      type: "element",
      tagName: "span",
      properties: {},
      children: [{ type: "text", value: "code" }],
    };
    expect(hastToHtml(node)).toBe("<span>code</span>");
  });

  test("converts element node with className", () => {
    const node: RootContent = {
      type: "element",
      tagName: "span",
      properties: { className: ["token", "keyword"] },
      children: [{ type: "text", value: "const" }],
    };
    expect(hastToHtml(node)).toBe('<span class="token keyword">const</span>');
  });

  test("handles nested elements", () => {
    const node: RootContent = {
      type: "element",
      tagName: "span",
      properties: { className: ["outer"] },
      children: [
        {
          type: "element",
          tagName: "em",
          properties: {},
          children: [{ type: "text", value: "inner" }],
        },
      ],
    };
    expect(hastToHtml(node)).toBe('<span class="outer"><em>inner</em></span>');
  });

  test("returns empty string for unknown node types", () => {
    const node = { type: "doctype" } as unknown as RootContent;
    expect(hastToHtml(node)).toBe("");
  });
});
