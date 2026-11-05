import { beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { highlightCode, loadCodeHighlighter } from "../lib/code-highlight";
import { HighlightedCode } from "./highlighted-code";

beforeAll(async () => {
  await loadCodeHighlighter();
});

function render(code: string, lang: string): string {
  const lines = highlightCode(code, lang);
  expect(lines).not.toBeNull();
  return renderToStaticMarkup(<HighlightedCode lines={lines!} />);
}

/** Text content of our own rendered markup (tags dropped, entities decoded). */
function textOf(html: string): string {
  let text = "";
  let inTag = false;
  for (const char of html) {
    if (char === "<") inTag = true;
    else if (char === ">") inTag = false;
    else if (!inTag) text += char;
  }
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}

test("renders token spans carrying both themes for CSS to choose between", () => {
  const html = render("const x = 1;", "js");
  expect(html.startsWith('<span class="hls">')).toBe(true);
  expect(html).toMatch(/<span style="[^"]*--hls-light:#[0-9a-f]+/i);
  expect(html).toMatch(/--hls-dark:#[0-9a-f]+/i);
  expect(html).toContain(">const </span>");
});

test("escapes code that looks like markup", () => {
  const html = render(
    `<script>alert("x")</script><img src=x onerror="a()">`,
    "html"
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;");
  expect(html).toContain("&quot;");
  // The only elements are the wrapper and token spans.
  expect(html.match(/<(\w+)/g)!.every((tag) => tag === "<span")).toBe(true);
});

test("escapes markup in languages with no syntax coloring of its own", () => {
  const html = render(`</code></pre><script>x</script>`, "diff");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("</pre>");
  expect(html).toContain("&lt;/code&gt;");
});

test("joins lines with newlines so the text round-trips", () => {
  const code = "a = 1\nb = 2\n";
  expect(textOf(render(code, "py"))).toBe(code);
});
