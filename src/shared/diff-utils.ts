import { diffChars, diffWords } from "diff";
import { refractor } from "refractor/all";
import type { RootContent, ElementContent } from "hast";

// ============================================================================
// Syntax Highlighting
// ============================================================================

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

interface OpenTag {
  tagName: string;
  className?: string;
}

export function hastToHtml(node: RootContent | ElementContent): string {
  if (node.type === "text") {
    return escapeHtml(node.value);
  }
  if (node.type === "element") {
    const { tagName, properties, children } = node;
    const className = (properties.className as string[] | undefined)?.join(" ");
    const attrs = className ? ` class="${className}"` : "";
    const inner = children.map(hastToHtml).join("");
    return `<${tagName}${attrs}>${inner}</${tagName}>`;
  }
  return "";
}

export function highlightFileByLines(content: string, lang: string): string[] {
  if (!content) return [];

  try {
    const tree = refractor.highlight(content, lang);
    const lines: string[] = [];
    let currentLine: string[] = [];
    const openTags: OpenTag[] = [];

    function closeAllTags(): string {
      return [...openTags]
        .reverse()
        .map((t) => `</${t.tagName}>`)
        .join("");
    }

    function openAllTags(): string {
      return openTags
        .map((t) => {
          const cls = t.className ? ` class="${t.className}"` : "";
          return `<${t.tagName}${cls}>`;
        })
        .join("");
    }

    function processText(text: string) {
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          currentLine.push(closeAllTags());
          lines.push(currentLine.join(""));
          currentLine = [openAllTags()];
        }
        if (parts[i]) {
          currentLine.push(escapeHtml(parts[i]));
        }
      }
    }

    function walkNode(node: RootContent | ElementContent) {
      if (node.type === "text") {
        processText(node.value);
      } else if (node.type === "element") {
        const { tagName, properties, children } = node;
        const className = (properties?.className as string[] | undefined)?.join(
          " "
        );
        const tag: OpenTag = { tagName, className };
        const cls = className ? ` class="${className}"` : "";
        currentLine.push(`<${tagName}${cls}>`);
        openTags.push(tag);
        children.forEach(walkNode);
        openTags.pop();
        currentLine.push(`</${tagName}>`);
      }
    }

    tree.children.forEach(walkNode);

    if (currentLine.length > 0) {
      lines.push(currentLine.join(""));
    }

    return lines;
  } catch {
    return content.split("\n").map(escapeHtml);
  }
}

// ============================================================================
// Inline Diff Segments
// ============================================================================

export interface RawLineSegment {
  value: string;
  type: "insert" | "delete" | "normal";
}

export function diffCharsIfWithinEditLimit(
  a: string,
  b: string,
  maxEdits = 4
):
  | { exceededLimit: true }
  | { exceededLimit: false; diffs: RawLineSegment[] } {
  const diffs = diffChars(a, b);
  let edits = 0;
  for (const part of diffs) {
    if (part.added || part.removed) {
      edits += part.value.length;
      if (edits > maxEdits) return { exceededLimit: true };
    }
  }
  return {
    exceededLimit: false,
    diffs: diffs.map((d) => ({
      value: d.value,
      type: d.added ? "insert" : d.removed ? "delete" : "normal",
    })),
  };
}

export function buildInlineDiffSegments(
  currentContent: string,
  nextContent: string,
  inlineMaxCharEdits: number
): RawLineSegment[] {
  const segments: RawLineSegment[] = diffWords(currentContent, nextContent).map(
    (token) => ({
      value: token.value,
      type: token.added ? "insert" : token.removed ? "delete" : "normal",
    })
  );

  const result: RawLineSegment[] = [];
  const mergeIntoResult = (segment: RawLineSegment) => {
    const last = result[result.length - 1];
    if (last && last.type === segment.type) {
      last.value += segment.value;
    } else {
      result.push(segment);
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const current = segments[i];
    const next = segments[i + 1];
    if (current.type === "delete" && next?.type === "insert") {
      const charDiff = diffCharsIfWithinEditLimit(
        current.value,
        next.value,
        inlineMaxCharEdits
      );
      if (!charDiff.exceededLimit) {
        charDiff.diffs.forEach(mergeIntoResult);
        i++;
      } else {
        result.push(current);
      }
    } else {
      mergeIntoResult(current);
    }
  }

  return result;
}
