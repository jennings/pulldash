import { useSyncExternalStore } from "react";
import type {
  Lang,
  Theme,
  ThemedToken,
  codeToTokens,
  isSupportedLanguage,
} from "@pierre/highlights";

/**
 * Syntax highlighting for the code blocks in rendered markdown (GitHub's
 * `body_html` and the markdown renderer's fenced code), with the same engine
 * and themes as the diff view: `@pierre/highlights` with `pierre-light` /
 * `pierre-dark`.
 *
 * One lexer pass emits both themes: every token carries `--hls-light` and
 * `--hls-dark` custom properties (plus `-font-style`/`-font-weight` variants),
 * and CSS keyed on the app's `.light`/`.dark` class on <html> picks the
 * colors (see `.hls` in index.css), so toggling the theme never re-highlights.
 *
 * The engine (a WebAssembly lexer bundle, ~0.5 MB) is imported on first use,
 * not at startup: markdown renders on pages that have no code block at all.
 * Until it has loaded, `highlightCode` returns `null` and callers render the
 * code as plain text; `useCodeHighlighterReady` re-renders them when it is
 * ready. The module is the same one the diff view loads, so whichever asks
 * first pays for it. If the browser cannot run the WebAssembly (no SIMD, or a
 * CSP without `wasm-unsafe-eval`) the import fails and code stays unhighlighted
 * (the diff view falls back to Shiki there; markdown does not, since GitHub's
 * own `pl-*` highlighting and plain text are acceptable for prose).
 */

/** A run of text with the CSS custom properties that color it. */
export interface HighlightedToken {
  content: string;
  /** Only `--hls-*` custom properties; apply as the element's `style`. */
  style: Readonly<Record<string, string>>;
}

/** Tokens grouped by line, without line terminators. */
export type HighlightedLines = readonly (readonly HighlightedToken[])[];

export interface Engine {
  codeToTokens: typeof codeToTokens;
  isSupportedLanguage: typeof isSupportedLanguage;
  light: Theme;
  dark: Theme;
}

/**
 * Names fences and linguist classes use that Highlights does not know. (Its
 * own aliases, e.g. `js`, `ts`, `py`, `sh`, `yml`, `rs`, `rb`, `c++`, `c#`,
 * are already handled by `isSupportedLanguage`, ignoring case.)
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  console: "shellsession",
  "html-basic": "html",
  mysql: "sql",
  node: "js",
  nodejs: "js",
  pgsql: "sql",
  postgres: "sql",
  postgresql: "sql",
  python3: "python",
  "shell-session": "shellsession",
  sqlite: "sql",
};

/** Plain-text names: highlighting them would only color everything the same. */
const PLAIN_LANGUAGES = new Set(["plain", "plaintext", "text", "txt"]);

/** Longer code is left plain: it would render as tens of thousands of spans. */
const MAX_HIGHLIGHT_CHARS = 200_000;

/** Lines this long (minified bundles) get one token instead of many. */
const MAX_LINE_LENGTH = 5_000;

/** Total characters of source kept in the highlight cache. */
const CACHE_CHAR_BUDGET = 1_000_000;

/** Imports the engine; fails where WebAssembly is unavailable. */
async function importEngine(): Promise<Engine> {
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

/**
 * Highlighter state: the lazily loaded engine, its readiness subscribers and
 * the result cache. The app uses one instance (the module-level functions
 * below); tests make their own with a stub `load`.
 */
export function createCodeHighlighter(load: () => Promise<Engine>) {
  let engine: Engine | null = null;
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const cache = new Map<string, HighlightedLines | null>();
  let cachedChars = 0;

  /**
   * Start loading the highlighter (once). Resolves when it is ready or has
   * failed; never rejects.
   */
  function loadEngine(): Promise<void> {
    loading ??= load().then(
      (loaded) => {
        engine = loaded;
        for (const listener of listeners) listener();
      },
      () => {
        // Unsupported environment: stay plain.
      }
    );
    return loading;
  }

  /** Subscribe to readiness changes (`useSyncExternalStore` signature). */
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function isReady(): boolean {
    return engine !== null;
  }

  /**
   * The Highlights language for a fence/class name, or `null` when it is
   * unknown, plain text, or the highlighter is not loaded yet. Compound GitHub
   * names (`css-scss`, `js-jsx`, `html-php`, `tex-latex`) resolve to their
   * last, else first, dash-separated part.
   */
  function resolveLanguage(raw: string): Lang | null {
    if (engine === null) return null;
    const lowered = raw.trim().toLowerCase();
    const parts = lowered.split("-");
    const candidates =
      parts.length > 1
        ? [lowered, parts[parts.length - 1]!, parts[0]!]
        : [lowered];
    for (const candidate of candidates) {
      const name = Object.hasOwn(LANGUAGE_ALIASES, candidate)
        ? LANGUAGE_ALIASES[candidate]!
        : candidate;
      if (PLAIN_LANGUAGES.has(name)) return null;
      if (engine.isSupportedLanguage(name)) return name;
    }
    return null;
  }

  /**
   * Highlight `code` as `lang`, or `null` when it should stay plain: the
   * highlighter is not ready (this starts loading it), the language is
   * unknown, or the code is too long. Never throws. Results are cached per
   * (lang, code), so re-rendering the same block is a lookup.
   */
  function highlight(code: string, lang: string): HighlightedLines | null {
    if (engine === null) {
      void loadEngine();
      return null;
    }
    if (code.length > MAX_HIGHLIGHT_CHARS) return null;
    const resolved = resolveLanguage(lang);
    if (resolved === null) return null;

    const key = `${resolved}\0${code}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let lines: HighlightedLines | null;
    try {
      lines = toLines(
        engine.codeToTokens(code, {
          lang: resolved,
          themes: { light: engine.light, dark: engine.dark },
          defaultColor: false,
          tokenizeMaxLineLength: MAX_LINE_LENGTH,
        }).tokens
      );
    } catch {
      lines = null;
    }

    cache.set(key, lines);
    cachedChars += key.length;
    for (const oldest of cache.keys()) {
      if (cachedChars <= CACHE_CHAR_BUDGET || oldest === key) break;
      cache.delete(oldest);
      cachedChars -= oldest.length;
    }
    return lines;
  }

  return { loadEngine, subscribe, isReady, resolveLanguage, highlight };
}

const shared = createCodeHighlighter(importEngine);

export const loadCodeHighlighter = shared.loadEngine;
export const resolveHighlightLanguage = shared.resolveLanguage;
export const highlightCode = shared.highlight;

function subscribeNothing(): () => void {
  return () => {};
}

function isNotReady(): boolean {
  return false;
}

/**
 * Re-render when the highlighter becomes ready; true once it is. Pass
 * `enabled: false` where there is no code to highlight, to skip subscribing.
 */
export function useCodeHighlighterReady(enabled = true): boolean {
  return useSyncExternalStore(
    enabled ? shared.subscribe : subscribeNothing,
    shared.isReady,
    isNotReady
  );
}

function toLines(tokens: ThemedToken[][]): HighlightedLines {
  return tokens.map((line) =>
    line.map((token) => ({
      content: token.content,
      style: token.htmlStyle ?? {},
    }))
  );
}
