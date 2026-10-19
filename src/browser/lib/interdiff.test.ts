import { test, expect, describe } from "bun:test";
import { structuredPatch } from "diff";
import { computeInterdiff, buildPostImageLines } from "./interdiff";
import { escapeHtml, hastToHtml } from "../../shared/diff-utils";
import type { DiffHunk, DiffSkipBlock, DiffLine } from "./diff-worker";
import type { RootContent } from "hast";

function changedContents(lines: DiffLine[], type: "delete" | "insert") {
  return lines
    .filter(
      (line) =>
        line.type === type ||
        (line.type === "normal" &&
          line.content.some((seg) => seg.type !== "normal"))
    )
    .map((line) =>
      line.content
        .filter((seg) => seg.type !== (type === "delete" ? "insert" : "delete"))
        .map((seg) => seg.value)
        .join("")
    );
}

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

describe("buildPostImageLines", () => {
  test("returns empty array for empty patch", () => {
    expect(buildPostImageLines("")).toEqual([]);
  });

  test("returns context and insert lines, not delete lines", () => {
    const patch = `@@ -1,4 +1,4 @@
 context1
 context2
-old_line
+new_line
 context3`;
    const lines = buildPostImageLines(patch);
    // gitdiff-parser strips the leading +/-/space marker from content
    expect(lines).toContain("context1");
    expect(lines).toContain("context2");
    expect(lines).toContain("new_line");
    expect(lines).not.toContain("old_line");
    expect(lines).toContain("context3");
  });
});

describe("computeInterdiff", () => {
  test("sparse patch windows retain gaps and source coordinates, including after a rebase", () => {
    const base = Array.from({ length: 110 }, (_, index) =>
      index % 10 < 5 ? "" : `line ${index + 1}`
    );
    base[39] = "from typing import TYPE_CHECKING, Literal, overload";
    base[49] = "def host_data(hostname_or_ip: str) -> dict[str, str]:";
    base[83] = "        self.password = h_data['password']";
    base[84] =
      "        self.skip_xo_config = h_data.get('skip_xo_config', False)";
    const oldLines = [...base];
    oldLines[39] = "from typing import TYPE_CHECKING, Any, Literal, overload";
    oldLines[49] = "def host_data(hostname_or_ip: str) -> dict[str, Any]:";
    oldLines[100] = "shared addition";
    const newLines = [...base];
    newLines[100] = "shared addition";
    newLines.splice(
      86,
      0,
      "        # Fail early when the host is down.",
      "        if not Host.ssh_reachable(hostname_or_ip):",
      "            raise Exception('unreachable')",
      ""
    );
    const patch = (base: string[], lines: string[]) =>
      structuredPatch(
        "host.py",
        "host.py",
        base.join("\n") + "\n",
        lines.join("\n") + "\n"
      )
        .hunks.map(
          (hunk) =>
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`
        )
        .join("\n");

    for (const offset of [0, 20]) {
      const prefix = Array.from(
        { length: offset },
        (_, index) => `rebase line ${index}`
      );
      const sources = [oldLines, [...prefix, ...newLines]];
      const result = computeInterdiff(
        patch(base, oldLines),
        patch([...prefix, ...base], sources[1]),
        "host.py"
      );
      const hunks = result.hunks.filter((hunk) => hunk.type === "hunk");
      expect(hunks.map((hunk) => [hunk.oldStart, hunk.newStart])).toEqual([
        [37, 37 + offset],
        [47, 47 + offset],
        [84, 84 + offset],
      ]);
      expect(result.hunks[0]).toMatchObject({
        type: "skip",
        count: 36 + offset,
      });
      expect(result.hunks[2]).toMatchObject({ type: "skip", count: 3 });
      for (const [side, number, excluded] of [
        [0, "oldLineNumber", "insert"],
        [1, "newLineNumber", "delete"],
      ] as const) {
        let previous = 0;
        for (const hunk of hunks) {
          let previousInHunk: number | undefined;
          for (const line of hunk.lines) {
            const n = line[number];
            if (n == null) continue;
            expect(n).toBeGreaterThan(previous);
            if (previousInHunk !== undefined)
              expect(n).toBe(previousInHunk + 1);
            expect(
              line.content
                .filter((seg) => seg.type !== excluded)
                .map((seg) => seg.value)
                .join("")
            ).toBe(sources[side][n - 1]);
            previous = previousInHunk = n;
          }
        }
      }
    }
  });

  test("reverted typing import changes use inline highlighting in both directions", () => {
    const patch = `@@ -37,7 +37,7 @@
 from lib.vm import VM
 from lib.xo import xo_cli, xo_object_exists
 
-from typing import TYPE_CHECKING, Literal, overload
+from typing import TYPE_CHECKING, Any, Literal, overload
 
 if TYPE_CHECKING:
     from lib.pool import Pool`;
    for (const [before, after, type] of [
      [patch, "", "delete"],
      ["", patch, "insert"],
    ] as const) {
      const result = computeInterdiff(before, after, "lib/host.py");
      const lines = result.hunks.flatMap((h) =>
        h.type === "hunk" ? h.lines : []
      );
      const line = lines.find((line) => line.newLineNumber === 40)!;
      expect(line.type).toBe("normal");
      expect(line.oldLineNumber).toBe(40);
      expect(
        line.content
          .filter((segment) => segment.type === type)
          .map((segment) => segment.value)
          .join("")
      ).toBe("Any, ");
      expect(
        line.content
          .filter((segment) => segment.type !== "insert")
          .map((segment) => segment.value)
          .join("")
      ).toBe(
        before
          ? "from typing import TYPE_CHECKING, Any, Literal, overload"
          : "from typing import TYPE_CHECKING, Literal, overload"
      );
      expect(
        line.content
          .filter((segment) => segment.type !== "delete")
          .map((segment) => segment.value)
          .join("")
      ).toBe(
        after
          ? "from typing import TYPE_CHECKING, Any, Literal, overload"
          : "from typing import TYPE_CHECKING, Literal, overload"
      );
      expect(lines.filter((line) => line.type !== "normal")).toEqual([]);
    }
  });

  test("reverted unrelated replacements keep all deletions before additions", () => {
    const patch = `@@ -40,2 +40,2 @@
-apple
-pear
+socket
+server`;
    const result = computeInterdiff(patch, "");
    const lines = result.hunks.flatMap((h) =>
      h.type === "hunk" ? h.lines : []
    );
    expect(
      lines.map((line) => [
        line.type,
        line.content.map((seg) => seg.value).join(""),
      ])
    ).toEqual([
      ["delete", "socket"],
      ["delete", "server"],
      ["insert", "apple"],
      ["insert", "pear"],
    ]);
  });

  test("identical patches produce empty output", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old_line
+new_line
 context`;
    const result = computeInterdiff(patch, patch);
    expect(result.hunks).toHaveLength(0);
  });

  test("real change in v2 produces non-empty diff", () => {
    const patch1 = `@@ -1,3 +1,3 @@
 context
-old_line
+v1_line
 context`;
    const patch2 = `@@ -1,3 +1,3 @@
 context
-old_line
+v2_line
 context`;
    const result = computeInterdiff(patch1, patch2);
    expect(result.hunks.length).toBeGreaterThan(0);
    const hunk = result.hunks.find((h) => h.type === "hunk") as DiffHunk;
    expect(hunk).toBeDefined();
    expect(changedContents(hunk.lines, "delete")).toContain("v1_line");
    expect(changedContents(hunk.lines, "insert")).toContain("v2_line");
  });

  test("rebase-only shift produces empty output", () => {
    // Same change but at different line positions due to rebase
    const patch1 = `@@ -10,5 +10,5 @@
 ctx1
 ctx2
-old
+new
 ctx3
 ctx4`;
    const patch2 = `@@ -20,5 +20,5 @@
 ctx1
 ctx2
-old
+new
 ctx3
 ctx4`;
    const result = computeInterdiff(patch1, patch2);
    // Both post-images have identical content lines → no diff
    expect(result.hunks).toHaveLength(0);
  });

  test("additional lines in v2 show as insertions", () => {
    const patch1 = `@@ -1,2 +1,3 @@
 context
-old
+v1_new
 context`;
    const patch2 = `@@ -1,2 +1,4 @@
 context
-old
+v2_new_line_a
+v2_new_line_b
 context`;
    const result = computeInterdiff(patch1, patch2);
    expect(result.hunks.length).toBeGreaterThan(0);
    const hunk = result.hunks.find((h) => h.type === "hunk") as DiffHunk;
    const insertLines = hunk.lines.filter((l) => l.type === "insert");
    expect(insertLines.length).toBeGreaterThanOrEqual(1);
  });

  test("empty patches produce empty output", () => {
    const result = computeInterdiff("", "");
    expect(result.hunks).toHaveLength(0);
  });

  test("v2 adds a second hunk that v1 did not touch", () => {
    // v1: changes line 10 only (3 lines of context each side)
    const patch1 = `@@ -7,7 +7,7 @@
 ctx7
 ctx8
 ctx9
-old10
+new10v1
 ctx11
 ctx12
 ctx13`;

    // v2: changes line 10 differently AND adds line 15
    // GitHub merges these into one big hunk (lines 7-18)
    const patch2 = `@@ -7,12 +7,13 @@
 ctx7
 ctx8
 ctx9
-old10
+new10v2
 ctx11
 ctx12
 ctx13
 ctx14
+new15
 ctx16
 ctx17
 ctx18`;

    const result = computeInterdiff(patch1, patch2);

    // Must have at least one hunk
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);

    const allLines = hunks.flatMap((h) => h.lines);
    const insertLines = allLines.filter((l) => l.type === "insert");
    const deleteLines = allLines.filter((l) => l.type === "delete");

    // The change at line 10 shows as a modify (delete + insert)
    expect(deleteLines.some((l) => l.oldLineNumber === 10)).toBe(true);
    expect(insertLines.some((l) => l.newLineNumber === 10)).toBe(true);

    // The new line 15 shows as an insert
    expect(insertLines.some((l) => l.newLineNumber === 15)).toBe(true);

    // Context lines 11-14 (shared between v1 and v2) must NOT be shown as inserts
    for (const n of [11, 12, 13, 14]) {
      expect(insertLines.some((l) => l.newLineNumber === n)).toBe(false);
    }
  });

  test("inline-and-shift: lines shifted by a deletion above are not marked changed", () => {
    // v1: commit adds a helper function (HELPER_DEF, HELPER_BODY, HELPER_END)
    // and changes the call site from OLD_CALL to CALL_HELPER.
    // v2: inlines the helper — helper function removed, call site changed to
    // INLINE_BODY.  PREAMBLE, MAIN_START, MAIN_END, AFTER are context in both.
    const patch1 = `@@ -1,5 +1,8 @@
 PREAMBLE
+HELPER_DEF
+HELPER_BODY
+HELPER_END
 MAIN_START
-OLD_CALL
+CALL_HELPER
 MAIN_END
 AFTER`;

    const patch2 = `@@ -1,5 +1,4 @@
 PREAMBLE
 MAIN_START
-OLD_CALL
+INLINE_BODY
 MAIN_END
 AFTER`;

    const result = computeInterdiff(patch1, patch2);
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);

    const allLines = hunks.flatMap((h) => h.lines);
    const insertLines = allLines.filter((l) => l.type === "insert");
    const deleteLines = allLines.filter((l) => l.type === "delete");

    // Helper function lines from v1 should be deleted
    const deletedContents = deleteLines.map((l) =>
      l.content.map((s) => s.value).join("")
    );
    expect(deletedContents.some((c) => c.includes("HELPER_DEF"))).toBe(true);
    expect(deletedContents.some((c) => c.includes("CALL_HELPER"))).toBe(true);

    // The inlined body should be inserted
    const insertedContents = insertLines.map((l) =>
      l.content.map((s) => s.value).join("")
    );
    expect(insertedContents.some((c) => c.includes("INLINE_BODY"))).toBe(true);

    // Shared context lines must NOT appear as inserts
    expect(
      insertLines.some((l) =>
        l.content.some(
          (s) =>
            s.value.includes("PREAMBLE") ||
            s.value.includes("MAIN_START") ||
            s.value.includes("MAIN_END") ||
            s.value.includes("AFTER")
        )
      )
    ).toBe(false);
  });

  test("deletion above shared block: shared block stays equal, not delete+insert", () => {
    // v1: adds block A (lines 1-3) and block B (lines 5-7)
    const patch1 = `@@ -1,6 +1,8 @@
 intro
+blockA_line1
+blockA_line2
 gap
+blockB_line1
+blockB_line2
 outro`;

    // v2: only adds block B (block A was removed in this revision)
    const patch2 = `@@ -1,3 +1,5 @@
 intro
 gap
+blockB_line1
+blockB_line2
 outro`;

    const result = computeInterdiff(patch1, patch2);
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);

    const allLines = hunks.flatMap((h) => h.lines);
    const insertLines = allLines.filter((l) => l.type === "insert");
    const deleteLines = allLines.filter((l) => l.type === "delete");

    // block A should show as deleted
    const deletedContents = deleteLines.map((l) =>
      l.content.map((s) => s.value).join("")
    );
    expect(deletedContents.some((c) => c.includes("blockA_line1"))).toBe(true);
    expect(deletedContents.some((c) => c.includes("blockA_line2"))).toBe(true);

    // block B is shared by both post-images; must NOT appear as delete or insert
    expect(
      deleteLines.some((l) => l.content.some((s) => s.value.includes("blockB")))
    ).toBe(false);
    expect(
      insertLines.some((l) => l.content.some((s) => s.value.includes("blockB")))
    ).toBe(false);
  });

  test("v2 deletes a line v1 doesn't touch shows the deletion", () => {
    // Mirrors the real-world case: v1 changes one region; v2 also changes
    // that region the same way AND swaps Main→TimeWanted in a region v1
    // never touched.  The lone -Main from v2's patch must surface as a
    // DELETE in the interdiff (older post-image-only algorithm dropped it).
    const patch1 = `@@ -1,5 +1,5 @@
 firstA
 firstB
-shared_old
+shared_new
 firstC`;
    const patch2 = `@@ -1,5 +1,5 @@
 firstA
 firstB
-shared_old
+shared_new
 firstC
@@ -10,3 +10,3 @@
 ctx_above
-setMenuState(HandoffView.Main)
+setMenuState(HandoffView.TimeWanted)
 ctx_below`;
    const result = computeInterdiff(patch1, patch2);
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(changedContents(allLines, "delete")).toContain(
      "setMenuState(HandoffView.Main)"
    );
    expect(changedContents(allLines, "insert")).toContain(
      "setMenuState(HandoffView.TimeWanted)"
    );
  });

  test("v1 deletes a line v2 doesn't touch shows as insert", () => {
    // v1 removes -orphan_line in a region v2's patch doesn't cover.
    // Since v2 still has that line in its file, the interdiff must show
    // it as an INSERT (it exists in v2 but not in v1).
    const patch1 = `@@ -1,4 +1,4 @@
 ctx_above
-orphan_line
+new_in_v1
 ctx_below
@@ -10,3 +10,3 @@
 other_ctx
-shared_old
+shared_new
 other_ctx_b`;
    const patch2 = `@@ -10,3 +10,3 @@
 other_ctx
-shared_old
+shared_new
 other_ctx_b`;
    const result = computeInterdiff(patch1, patch2);
    const allLines = (
      result.hunks.filter((h) => h.type === "hunk") as DiffHunk[]
    ).flatMap((h) => h.lines);
    const inserts = allLines.filter((l) => l.type === "insert");
    const deletes = allLines.filter((l) => l.type === "delete");
    expect(
      inserts.some((l) =>
        l.content.some((s) => s.value.includes("orphan_line"))
      )
    ).toBe(true);
    expect(
      deletes.some((l) => l.content.some((s) => s.value.includes("new_in_v1")))
    ).toBe(true);
  });

  test("v1 adds a line v2 deletes shows as single delete", () => {
    // v1 inserts X.  v2 deletes X.  Net result: X is gone in v2's file but
    // present in v1's → DELETE in the interdiff (no INSERT counterpart).
    const patch1 = `@@ -1,3 +1,4 @@
 ctx
+X
 ctx2
 ctx3`;
    const patch2 = `@@ -1,4 +1,3 @@
 ctx
-X
 ctx2
 ctx3`;
    const result = computeInterdiff(patch1, patch2);
    const allLines = (
      result.hunks.filter((h) => h.type === "hunk") as DiffHunk[]
    ).flatMap((h) => h.lines);
    const deletes = allLines.filter((l) => l.type === "delete");
    const inserts = allLines.filter((l) => l.type === "insert");
    expect(deletes.some((l) => l.content.some((s) => s.value === "X"))).toBe(
      true
    );
    expect(inserts).toHaveLength(0);
  });

  test("both versions delete same line with different replacements", () => {
    // Shared deletion is rebase noise; only the divergent replacements
    // surface as a delete/insert pair.
    const patch1 = `@@ -1,3 +1,3 @@
 ctx
-shared_removed
+v1_replacement
 ctx2`;
    const patch2 = `@@ -1,3 +1,3 @@
 ctx
-shared_removed
+v2_replacement
 ctx2`;
    const result = computeInterdiff(patch1, patch2);
    const allLines = (
      result.hunks.filter((h) => h.type === "hunk") as DiffHunk[]
    ).flatMap((h) => h.lines);
    expect(changedContents(allLines, "delete")).toEqual(["v1_replacement"]);
    expect(changedContents(allLines, "insert")).toEqual(["v2_replacement"]);
  });

  test("delete-only change in v2 includes surrounding context", () => {
    // v2's patch deletes `removed_line` flanked by 3+ context lines on each
    // side.  Hunk should include those context lines and a sensible
    // newStart line number (the line starts as a pure DELETE).
    const patch1 = `@@ -1,3 +1,3 @@
 unrelated_a
-unrelated_old
+unrelated_new
 unrelated_b`;
    const patch2 = `@@ -1,3 +1,3 @@
 unrelated_a
-unrelated_old
+unrelated_new
 unrelated_b
@@ -10,7 +10,6 @@
 ctx_a
 ctx_b
 ctx_c
-removed_line
 ctx_d
 ctx_e
 ctx_f`;
    const result = computeInterdiff(patch1, patch2);
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    const allLines = hunks.flatMap((h) => h.lines);
    const deletes = allLines.filter((l) => l.type === "delete");
    const normals = allLines.filter((l) => l.type === "normal");
    expect(
      deletes.some((l) =>
        l.content.some((s) => s.value.includes("removed_line"))
      )
    ).toBe(true);
    expect(
      normals.some((l) => l.content.some((s) => s.value.includes("ctx_b")))
    ).toBe(true);
    expect(
      normals.some((l) => l.content.some((s) => s.value.includes("ctx_d")))
    ).toBe(true);
    const deleteHunk = hunks.find((h) =>
      h.lines.some(
        (l) =>
          l.type === "delete" &&
          l.content.some((s) => s.value.includes("removed_line"))
      )
    );
    expect(deleteHunk).toBeDefined();
    expect(deleteHunk!.newStart).toBeGreaterThan(0);
  });

  test("context/delete in equal LCS: v1 has line as context, v2 deletes it", () => {
    const patch1 = [
      "@@ -1,5 +1,5 @@",
      " ctx_a",
      "-old_line",
      "+new_line_v1",
      " kept_line",
      " ctx_b",
      " ctx_c",
    ].join("\n");
    const patch2 = [
      "@@ -1,6 +1,5 @@",
      " ctx_a",
      "-old_line",
      "+new_line_v2",
      " kept_line",
      " ctx_b",
      "-ctx_c",
      " ctx_d",
    ].join("\n");
    const result = computeInterdiff(patch1, patch2);
    const hunks = result.hunks.filter((h) => h.type === "hunk") as DiffHunk[];
    expect(hunks.length).toBeGreaterThan(0);
    const allLines = hunks.flatMap((h) => h.lines);
    const deletes = changedContents(allLines, "delete");
    const inserts = changedContents(allLines, "insert");
    // "ctx_c" was context in v1, deleted in v2 → must show as DELETE
    expect(deletes).toContain("ctx_c");
    // "new_line_v1" was inserted in v1, not in v2 → must show as DELETE
    expect(deletes).toContain("new_line_v1");
    // "new_line_v2" was inserted in v2, not in v1 → must show as INSERT
    expect(inserts).toContain("new_line_v2");
    // "kept_line" is context in both patches → EQUAL (not in deletes or inserts)
    expect(deletes).not.toContain("kept_line");
  });

  test("delete/context in equal LCS: v1 deletes line, v2 keeps as context", () => {
    // Both patches modify the same shared lines. "X" appears as delete in
    // patch1 (v1 removed it) and as context in patch2 (v2 kept it).
    // The LCS matches "X" as equal → delete/context → INSERT.
    const patch1 = [
      "@@ -1,3 +1,2 @@",
      "-before",
      "+before_v1",
      "-X",
      " after",
    ].join("\n");
    const patch2 = [
      "@@ -1,3 +1,3 @@",
      "-before",
      "+before_v2",
      " X",
      "-after",
      "+after_v2",
    ].join("\n");
    const result = computeInterdiff(patch1, patch2);
    const allLines = (
      result.hunks.filter((h) => h.type === "hunk") as DiffHunk[]
    ).flatMap((h) => h.lines);
    const inserts = changedContents(allLines, "insert");
    const deletes = changedContents(allLines, "delete");
    // "X" was deleted in v1, kept as context in v2 → INSERT
    expect(inserts).toContain("X");
    // "after" was context in v1, deleted in v2 → DELETE
    expect(deletes).toContain("after");
    // "before_v1" was inserted in v1 only → DELETE
    expect(deletes).toContain("before_v1");
    // "before_v2" was inserted in v2 only → INSERT
    expect(inserts).toContain("before_v2");
    // "after_v2" was inserted in v2 only → INSERT
    expect(inserts).toContain("after_v2");
  });

  test("skip-block counts match real file-line gaps, not flat-array indices", () => {
    // v1 changes line 617; v2 changes line 617 differently. The patches carry
    // only ~7 lines of on-patch content each. A correct interdiff must report
    // a leading skip of 616 lines (to the file's first shown line) and a
    // trailing "to end" sentinel — NOT small counts derived from positions in
    // the internal flat array.
    const patch1 = [
      "@@ -614,7 +614,7 @@",
      " ctx_a",
      " ctx_b",
      " ctx_c",
      "-old617",
      "+new617_v1",
      " ctx_d",
      " ctx_e",
    ].join("\n");
    const patch2 = [
      "@@ -614,7 +614,7 @@",
      " ctx_a",
      " ctx_b",
      " ctx_c",
      "-old617",
      "+new617_v2",
      " ctx_d",
      " ctx_e",
    ].join("\n");

    const result = computeInterdiff(patch1, patch2);

    const firstHunk = result.hunks.find((h) => h.type === "hunk") as DiffHunk;
    expect(firstHunk).toBeDefined();
    // Hunk is anchored around line 617 in the post-image (head file).
    expect(firstHunk.newStart).toBe(614);

    const skips = result.hunks.filter(
      (h) => h.type === "skip"
    ) as DiffSkipBlock[];
    expect(skips.length).toBeGreaterThanOrEqual(2);

    const leading = skips[0];
    // Bug regression check: leading count used to be ~7 (flat-array size);
    // must now be 613 (lines 1..613 preceding the hunk at line 614).
    expect(leading.count).toBe(613);

    // Trailing skip carries a sentinel — the worker doesn't know EOF, so the
    // expansion path clamps it to the fetched file's actual length.
    const trailing = skips[skips.length - 1];
    expect(trailing.count).toBe(Number.MAX_SAFE_INTEGER);
    expect(trailing.content.length).toBeGreaterThan(0);
  });

  test("B-only trailing context uses running old-side counter, not v2 number", () => {
    // Reproduces the jj-vcs/jj#9728 cli-reference@.md.snap case: patch2
    // extends farther in inserts than patch1, so v2's trailing context blanks
    // fall into a B-only chunk. Previously we set oldLine = newLine on those,
    // producing a hunk with a phantom gap on the old side.
    const patch1 = [
      "@@ -100,3 +100,5 @@",
      " ctx",
      "+ins_a",
      "+ins_b",
      " tail1",
      " tail2",
    ].join("\n");
    const patch2 = [
      "@@ -100,3 +100,7 @@",
      " ctx",
      "+ins_a",
      "+ins_b",
      "+ins_c",
      "+ins_d",
      " tail1",
      " tail2",
    ].join("\n");

    const result = computeInterdiff(patch1, patch2);
    const hunk = result.hunks.find((h) => h.type === "hunk") as DiffHunk;
    expect(hunk).toBeDefined();

    // Find the last two equal (normal) lines and confirm the pair advances by
    // 1 on both sides, not with a phantom jump on the old side.
    const equals = hunk.lines.filter((l) => l.type === "normal");
    expect(equals.length).toBeGreaterThanOrEqual(2);
    const last = equals[equals.length - 1];
    const prev = equals[equals.length - 2];
    expect(last.oldLineNumber! - prev.oldLineNumber!).toBe(1);
    expect(last.newLineNumber! - prev.newLineNumber!).toBe(1);
  });

  test("both patches add same line: insert/insert equals to equal", () => {
    const patch1 = [
      "@@ -1,3 +1,4 @@",
      " ctx_a",
      "+common_addition",
      " ctx_b",
      " ctx_c",
    ].join("\n");
    const patch2 = [
      "@@ -10,3 +10,4 @@",
      " ctx_x",
      "+common_addition",
      " ctx_y",
      " ctx_z",
    ].join("\n");
    const result = computeInterdiff(patch1, patch2);
    const allLines = (
      result.hunks.filter((h) => h.type === "hunk") as DiffHunk[]
    ).flatMap((h) => h.lines);
    const inserts = allLines.filter((l) => l.type === "insert");
    const deletes = allLines.filter((l) => l.type === "delete");
    expect(
      inserts.some((l) =>
        l.content.some((s) => s.value.includes("common_addition"))
      )
    ).toBe(false);
    expect(
      deletes.some((l) =>
        l.content.some((s) => s.value.includes("common_addition"))
      )
    ).toBe(false);
  });
});
