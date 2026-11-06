import { test, expect, describe } from "bun:test";
import { escapeHtml } from "./html";

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
