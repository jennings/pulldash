import { test, expect, describe } from "bun:test";
import { structuredPatch } from "diff";
import { computeInterdiff } from "./interdiff";
import { diffRows, fileDiffFromPatch, type DiffRow } from "./file-diff";

function interdiff(patch1: string, patch2: string) {
  const patch = computeInterdiff(patch1, patch2);
  const fileDiff = fileDiffFromPatch({ patch, filename: "f.ts" });
  const rows = diffRows(fileDiff);
  const lines = rows.filter(
    (row): row is Extract<DiffRow, { kind: "line" }> => row.kind === "line"
  );
  const texts = (type: "addition" | "deletion") =>
    lines.filter((row) => row.type === type).map((row) => row.text);
  return {
    patch,
    fileDiff,
    rows,
    lines,
    inserts: texts("addition"),
    deletes: texts("deletion"),
  };
}

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
      const { fileDiff, rows, lines } = interdiff(
        patch(base, oldLines),
        patch([...prefix, ...base], sources[1])
      );
      expect(
        fileDiff.hunks.map((hunk) => [hunk.deletionStart, hunk.additionStart])
      ).toEqual([
        [37, 37 + offset],
        [47, 47 + offset],
        [84, 84 + offset],
      ]);
      expect(rows[0]).toMatchObject({
        kind: "gap",
        hunkIndex: 0,
        count: 36 + offset,
      });
      const gaps = rows.filter((row) => row.kind === "gap");
      expect(gaps[1]).toMatchObject({ hunkIndex: 1, count: 3 });
      for (const [side, number] of [
        [0, "oldLine"],
        [1, "newLine"],
      ] as const) {
        let previous = 0;
        let previousInHunk: number | undefined;
        let hunkOfPrevious = -1;
        for (const line of lines) {
          const n = line[number];
          if (n == null) continue;
          if (line.hunkIndex !== hunkOfPrevious) previousInHunk = undefined;
          hunkOfPrevious = line.hunkIndex;
          expect(n).toBeGreaterThan(previous);
          if (previousInHunk !== undefined) expect(n).toBe(previousInHunk + 1);
          expect(line.text).toBe(sources[side][n - 1]);
          previous = previousInHunk = n;
        }
      }
    }
  });

  test("reverted typing import changes show as a replacement in both directions", () => {
    const patch = `@@ -37,7 +37,7 @@
 from lib.vm import VM
 from lib.xo import xo_cli, xo_object_exists
 
-from typing import TYPE_CHECKING, Literal, overload
+from typing import TYPE_CHECKING, Any, Literal, overload
 
 if TYPE_CHECKING:
     from lib.pool import Pool`;
    const plain = "from typing import TYPE_CHECKING, Literal, overload";
    const withAny = "from typing import TYPE_CHECKING, Any, Literal, overload";
    for (const [before, after, removed, added] of [
      [patch, "", withAny, plain],
      ["", patch, plain, withAny],
    ] as const) {
      const { lines } = interdiff(before, after);
      const deletion = lines.find((line) => line.type === "deletion")!;
      const addition = lines.find((line) => line.type === "addition")!;
      expect([deletion.oldLine, deletion.text]).toEqual([40, removed]);
      expect([addition.newLine, addition.text]).toEqual([40, added]);
      expect(lines.filter((line) => line.type !== "context")).toHaveLength(2);
    }
  });

  test("reverted unrelated replacements keep all deletions before additions", () => {
    const patch = `@@ -40,2 +40,2 @@
-apple
-pear
+socket
+server`;
    const { lines } = interdiff(patch, "");
    expect(lines.map((line) => [line.type, line.text])).toEqual([
      ["deletion", "socket"],
      ["deletion", "server"],
      ["addition", "apple"],
      ["addition", "pear"],
    ]);
  });

  test("identical patches produce empty output", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old_line
+new_line
 context`;
    expect(computeInterdiff(patch, patch)).toBe("");
    expect(interdiff(patch, patch).fileDiff.hunks).toHaveLength(0);
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
    const { fileDiff, deletes, inserts } = interdiff(patch1, patch2);
    expect(fileDiff.hunks.length).toBeGreaterThan(0);
    expect(deletes).toContain("v1_line");
    expect(inserts).toContain("v2_line");
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
    // Both post-images have identical content lines → no diff
    expect(computeInterdiff(patch1, patch2)).toBe("");
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
    const { inserts } = interdiff(patch1, patch2);
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  test("empty patches produce empty output", () => {
    expect(computeInterdiff("", "")).toBe("");
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

    const { lines } = interdiff(patch1, patch2);
    const inserts = lines.filter((l) => l.type === "addition");
    const deletes = lines.filter((l) => l.type === "deletion");

    // The change at line 10 shows as a modify (delete + insert)
    expect(deletes.some((l) => l.oldLine === 10)).toBe(true);
    expect(inserts.some((l) => l.newLine === 10)).toBe(true);

    // The new line 15 shows as an insert
    expect(inserts.some((l) => l.newLine === 15)).toBe(true);

    // Context lines 11-14 (shared between v1 and v2) must NOT be shown as inserts
    for (const n of [11, 12, 13, 14]) {
      expect(inserts.some((l) => l.newLine === n)).toBe(false);
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

    const { inserts, deletes } = interdiff(patch1, patch2);

    // Helper function lines from v1 should be deleted
    expect(deletes.some((c) => c.includes("HELPER_DEF"))).toBe(true);
    expect(deletes.some((c) => c.includes("CALL_HELPER"))).toBe(true);

    // The inlined body should be inserted
    expect(inserts.some((c) => c.includes("INLINE_BODY"))).toBe(true);

    // Shared context lines must NOT appear as inserts
    expect(
      inserts.some(
        (c) =>
          c.includes("PREAMBLE") ||
          c.includes("MAIN_START") ||
          c.includes("MAIN_END") ||
          c.includes("AFTER")
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

    const { inserts, deletes } = interdiff(patch1, patch2);

    // block A should show as deleted
    expect(deletes.some((c) => c.includes("blockA_line1"))).toBe(true);
    expect(deletes.some((c) => c.includes("blockA_line2"))).toBe(true);

    // block B is shared by both post-images; must NOT appear as delete or insert
    expect(deletes.some((c) => c.includes("blockB"))).toBe(false);
    expect(inserts.some((c) => c.includes("blockB"))).toBe(false);
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
    const { fileDiff, deletes, inserts } = interdiff(patch1, patch2);
    expect(fileDiff.hunks.length).toBeGreaterThan(0);
    expect(deletes).toContain("setMenuState(HandoffView.Main)");
    expect(inserts).toContain("setMenuState(HandoffView.TimeWanted)");
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
    const { inserts, deletes } = interdiff(patch1, patch2);
    expect(inserts.some((c) => c.includes("orphan_line"))).toBe(true);
    expect(deletes.some((c) => c.includes("new_in_v1"))).toBe(true);
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
    const { inserts, deletes } = interdiff(patch1, patch2);
    expect(deletes).toContain("X");
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
    const { inserts, deletes } = interdiff(patch1, patch2);
    expect(deletes).toEqual(["v1_replacement"]);
    expect(inserts).toEqual(["v2_replacement"]);
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
    const { fileDiff, lines } = interdiff(patch1, patch2);
    const contexts = lines.filter((l) => l.type === "context");
    expect(lines.some((l) => l.text === "removed_line")).toBe(true);
    expect(contexts.some((l) => l.text === "ctx_b")).toBe(true);
    expect(contexts.some((l) => l.text === "ctx_d")).toBe(true);
    const deleteHunk = fileDiff.hunks.find((h) =>
      h.hunkContent.some((c) => c.type === "change" && c.deletions > 0)
    );
    expect(deleteHunk).toBeDefined();
    expect(deleteHunk!.additionStart).toBeGreaterThan(0);
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
    const { fileDiff, deletes, inserts } = interdiff(patch1, patch2);
    expect(fileDiff.hunks.length).toBeGreaterThan(0);
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
    const { inserts, deletes } = interdiff(patch1, patch2);
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

  test("gap counts match real file-line gaps, not flat-array indices", () => {
    // v1 changes line 617; v2 changes line 617 differently. The patches carry
    // only ~7 lines of on-patch content each. A correct interdiff must report
    // a leading gap of 613 lines (to the file's first shown line) and no
    // trailing gap: the file's length is unknown until it is hydrated.
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

    const { fileDiff, rows } = interdiff(patch1, patch2);
    // Hunk is anchored around line 617 in the post-image (head file).
    expect(fileDiff.hunks[0]!.additionStart).toBe(614);
    expect(rows[0]).toMatchObject({
      kind: "gap",
      hunkIndex: 0,
      count: 613,
      oldStart: 1,
      newStart: 1,
    });
    expect(rows.filter((row) => row.kind === "gap")).toHaveLength(1);
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

    const { fileDiff, lines } = interdiff(patch1, patch2);
    expect(fileDiff.hunks).toHaveLength(1);

    // The last two context lines advance by 1 on both sides, not with a
    // phantom jump on the old side.
    const equals = lines.filter((l) => l.type === "context");
    expect(equals.length).toBeGreaterThanOrEqual(2);
    const last = equals[equals.length - 1]!;
    const prev = equals[equals.length - 2]!;
    expect(last.oldLine! - prev.oldLine!).toBe(1);
    expect(last.newLine! - prev.newLine!).toBe(1);
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
    const { inserts, deletes } = interdiff(patch1, patch2);
    expect(inserts.some((c) => c.includes("common_addition"))).toBe(false);
    expect(deletes.some((c) => c.includes("common_addition"))).toBe(false);
  });
});
