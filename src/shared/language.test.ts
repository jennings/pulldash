import { expect, test } from "bun:test";
import { guessLang } from "./language";

test("language detection handles formerly divergent diff grammars and fallback", () => {
  expect(
    [
      "file.mjs",
      "file.cjs",
      "file.kt",
      "file.scss",
      "file.sql",
      "file.toml",
      "image.SVG",
    ].map(guessLang)
  ).toEqual([
    "javascript",
    "javascript",
    "kotlin",
    "scss",
    "sql",
    "toml",
    "markup",
  ]);
  expect(guessLang("unknown.extension")).toBe("tsx");
  expect(guessLang()).toBe("tsx");
});
