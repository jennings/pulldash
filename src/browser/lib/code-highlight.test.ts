import { beforeAll, describe, expect, test } from "bun:test";
import {
  createCodeHighlighter,
  highlightCode,
  loadCodeHighlighter,
  resolveHighlightLanguage,
  type Engine,
} from "./code-highlight";

async function realEngine(): Promise<Engine> {
  const [highlights, light, dark] = await Promise.all([
    import("@pierre/highlights"),
    import("@pierre/highlights/themes/pierre-light"),
    import("@pierre/highlights/themes/pierre-dark"),
  ]);
  return {
    codeToTokens: highlights.codeToTokens,
    isSupportedLanguage: highlights.isSupportedLanguage,
    light: light.default,
    dark: dark.default,
  };
}

describe("with the highlighter loaded", () => {
  beforeAll(async () => {
    await loadCodeHighlighter();
  });

  test("resolves fence and class names, aliases and case", () => {
    const names = [
      "js",
      "javascript",
      "ts",
      "tsx",
      "jsx",
      "py",
      "python",
      "sh",
      "bash",
      "shell",
      "zsh",
      "yml",
      "yaml",
      "rs",
      "rb",
      "go",
      "diff",
      "json",
      "html",
      "css",
      "sql",
      "dockerfile",
      "c++",
      "c#",
      "toml",
      "  JS  ",
    ];
    for (const name of names) {
      expect(resolveHighlightLanguage(name)).not.toBeNull();
    }
    expect(resolveHighlightLanguage("  JS  ")).toBe("js");
  });

  test("resolves GitHub's compound language names by their parts", () => {
    expect(resolveHighlightLanguage("css-scss")).toBe("scss");
    expect(resolveHighlightLanguage("css-less")).toBe("less");
    expect(resolveHighlightLanguage("js-jsx")).toBe("jsx");
    expect(resolveHighlightLanguage("html-php")).toBe("php");
    expect(resolveHighlightLanguage("tex-latex")).toBe("latex");
    expect(resolveHighlightLanguage("shell-session")).toBe("shellsession");
    expect(resolveHighlightLanguage("html-django")).toBe("html");
    // A full name wins over its parts.
    expect(resolveHighlightLanguage("objective-c")).toBe("objective-c");
    expect(resolveHighlightLanguage("foo-bar")).toBeNull();
    expect(resolveHighlightLanguage("source-text")).toBeNull();
  });

  test("maps names Highlights lacks to a close language", () => {
    expect(resolveHighlightLanguage("console")).toBe("shellsession");
    expect(resolveHighlightLanguage("html-basic")).toBe("html");
    expect(resolveHighlightLanguage("postgres")).toBe("sql");
    expect(resolveHighlightLanguage("node")).toBe("js");
  });

  test("leaves unknown names and plain text unhighlighted", () => {
    for (const name of [
      "notalang",
      "",
      "constructor",
      "__proto__",
      "toString",
      "text",
      "txt",
      "plain",
      "plaintext",
    ]) {
      expect(resolveHighlightLanguage(name)).toBeNull();
    }
    expect(highlightCode("const x = 1;", "notalang")).toBeNull();
    expect(highlightCode("hello", "text")).toBeNull();
  });

  test("emits per-line tokens that reproduce the source", () => {
    const code = "const x = 1; // note\nlet y = 'a';\n";
    const lines = highlightCode(code, "ts");
    expect(lines).not.toBeNull();
    // A trailing newline yields a final empty line.
    expect(lines).toHaveLength(3);
    expect(lines![2]).toHaveLength(0);
    expect(
      lines!.map((line) => line.map((t) => t.content).join("")).join("\n")
    ).toBe(code);
    expect(lines![0]!.length).toBeGreaterThan(1);
  });

  test("every token carries both themes as custom properties only", () => {
    const lines = highlightCode("const x = 1;", "js")!;
    const tokens = lines.flat();
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(Object.keys(token.style).length).toBeGreaterThan(0);
      for (const name of Object.keys(token.style)) {
        expect(name.startsWith("--hls-")).toBe(true);
      }
      expect(token.style["--hls-light"]).toMatch(/^#[0-9a-f]{3,8}$/i);
      expect(token.style["--hls-dark"]).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
    // Light and dark are different palettes for at least some tokens.
    expect(
      tokens.some((t) => t.style["--hls-light"] !== t.style["--hls-dark"])
    ).toBe(true);
  });

  test("keeps markup in code as plain token text", () => {
    const code = `<script>alert("x")</script><img src=x onerror="a()">`;
    const lines = highlightCode(code, "html")!;
    expect(
      lines
        .flat()
        .map((t) => t.content)
        .join("")
    ).toBe(code);
  });

  test("returns the same result for the same code and language", () => {
    const first = highlightCode("fn main() {}", "rust");
    expect(first).not.toBeNull();
    expect(highlightCode("fn main() {}", "rust")).toBe(first);
  });

  test("collapses very long lines instead of emitting thousands of tokens", () => {
    const line = "a, ".repeat(5_000);
    const lines = highlightCode(line, "js")!;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    expect(lines[0]![0]!.content).toBe(line);
  });

  test("skips code too large to render as tokens", () => {
    expect(highlightCode("a\n".repeat(150_000), "js")).toBeNull();
  });
});

describe("loading", () => {
  test("highlighting a block starts the load once and notifies subscribers", async () => {
    const engine = await realEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let loads = 0;
    const highlighter = createCodeHighlighter(async () => {
      loads++;
      await gate;
      return engine;
    });
    let notified = 0;
    highlighter.subscribe(() => notified++);

    expect(highlighter.isReady()).toBe(false);
    expect(loads).toBe(0);

    // Plain until ready, but asking is what starts the load.
    expect(highlighter.highlight("const x = 1;", "js")).toBeNull();
    expect(highlighter.highlight("let y = 2;", "ts")).toBeNull();
    expect(loads).toBe(1);
    expect(notified).toBe(0);

    release();
    await highlighter.loadEngine();
    expect(highlighter.isReady()).toBe(true);
    expect(notified).toBe(1);
    expect(highlighter.highlight("const x = 1;", "js")).not.toBeNull();
    expect(loads).toBe(1);
  });

  test("a failed load leaves code plain and never throws", async () => {
    let loads = 0;
    const highlighter = createCodeHighlighter(() => {
      loads++;
      return Promise.reject(new Error("no wasm"));
    });
    let notified = 0;
    highlighter.subscribe(() => notified++);

    expect(highlighter.highlight("const x = 1;", "js")).toBeNull();
    await highlighter.loadEngine();
    expect(highlighter.isReady()).toBe(false);
    expect(highlighter.highlight("const x = 1;", "js")).toBeNull();
    expect(highlighter.resolveLanguage("js")).toBeNull();
    expect(notified).toBe(0);
    expect(loads).toBe(1);
  });

  test("unsubscribed listeners are not notified", async () => {
    const engine = await realEngine();
    const highlighter = createCodeHighlighter(() => Promise.resolve(engine));
    let notified = 0;
    const unsubscribe = highlighter.subscribe(() => notified++);
    unsubscribe();
    await highlighter.loadEngine();
    expect(notified).toBe(0);
  });
});
