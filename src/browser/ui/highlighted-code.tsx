import { memo, type CSSProperties, type ReactNode } from "react";
import type { HighlightedLines } from "../lib/code-highlight";

/**
 * Highlighted code as React elements: token text is always a text child, never
 * markup, so code containing `<script>` or entities renders as itself. Each
 * token's `style` holds only the `--hls-*` custom properties that
 * `.hls > span` in index.css turns into a color for the current theme.
 */
export const HighlightedCode = memo(function HighlightedCode({
  lines,
}: {
  lines: HighlightedLines;
}) {
  const children: ReactNode[] = [];
  let key = 0;
  lines.forEach((line, index) => {
    if (index > 0) children.push("\n");
    for (const token of line) {
      children.push(
        <span key={key++} style={token.style as CSSProperties}>
          {token.content}
        </span>
      );
    }
  });
  return <span className="hls">{children}</span>;
});
