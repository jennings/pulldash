import { test, expect } from "bun:test";
import { buildInlineDiffSegments } from "@/shared/diff-utils";

// Real-world example from xcp-ng/xcp-ng-tests#570 lib/host.py
const OLD =
  "        cmd = 'yum install --setopt=skip_missing_names_on_install=False -y'";
const NEW =
  "        opts = '--setopt=skip_missing_names_on_install=False' if self.pm == 'yum' else ''";

function simulateProcessedContent(
  segments: ReturnType<typeof buildInlineDiffSegments>
) {
  const result: { value: string; type: "insert" | "delete" | "normal" }[] = [];
  let lastNormal: string | null = null;
  for (const seg of segments) {
    if ((seg.type === "insert" || seg.type === "delete") && seg.value.trim()) {
      const m = seg.value.match(/^(\s+)/);
      if (m && lastNormal !== m[1]) {
        lastNormal = m[1];
        result.push({ value: m[1], type: "normal" });
      }
      result.push({
        value: seg.value.trimStart(),
        type: seg.type,
      });
    } else if (seg.type === "normal") {
      lastNormal = seg.value;
      result.push(seg);
    } else {
      result.push(seg);
    }
  }
  return result;
}

test("unified view preserves whitespace around insert/delete", () => {
  const segments = buildInlineDiffSegments(OLD, NEW, 4);
  const result = simulateProcessedContent(segments);
  const renderedText = result.map((s) => s.value).join("");

  // Space before = must be preserved
  expect(renderedText).toContain("opts =");

  // Leading indent must appear exactly once
  const indent = "        ";
  expect(renderedText.startsWith(indent)).toBe(true);
  expect(renderedText.indexOf(indent, indent.length)).toBe(-1);
});

function simulateSplitOldText(
  segments: ReturnType<typeof buildInlineDiffSegments>
) {
  const oldSegments = segments.filter((s) => s.type !== "insert");
  const fullOldText = oldSegments.map((s) => s.value).join("");
  return fullOldText;
}

test("split view preserves space before = in old text reconstruction", () => {
  const segments = buildInlineDiffSegments(OLD, NEW, 4);
  const oldText = simulateSplitOldText(segments);

  // The reconstructed old text must preserve the space before =
  expect(oldText).toContain("cmd =");

  // Leading indent must appear once
  const indent = "        ";
  expect(oldText.startsWith(indent)).toBe(true);
  expect(oldText.indexOf(indent, indent.length)).toBe(-1);
});
