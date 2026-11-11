// Regression tests from the home-grown diff pipeline, ported to what Pierre
// renders: each checks the rendered rows (order, gutters, split pairing, word
// diff spans, token colors) for the fixture of a bug fixed before.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  getSharedHighlighter,
  hydratePartialDiff,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { fileDiffFromPatch } from "./file-diff";
import { DIFF_THEMES } from "./pierre";

const highlighter = await getSharedHighlighter({
  themes: [DIFF_THEMES.light, DIFF_THEMES.dark],
  langs: [],
  preferredHighlighter: "highlights",
});

interface Row {
  side: "old" | "new";
  line: number;
  type: string;
  text: string;
  /** Word diff spans. */
  spans: string[];
  /** Highlighted pieces as [text, dark theme color]. */
  tokens: [string, string][];
  unified: number;
  split: number;
}

interface Node {
  type: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const textOf = (n: Node): string =>
  n.type === "text" ? n.value! : (n.children ?? []).map(textOf).join("");

const spansOf = (n: Node): string[] =>
  n.type !== "element"
    ? []
    : n.properties && "data-diff-span" in n.properties
      ? [textOf(n)]
      : (n.children ?? []).flatMap(spansOf);

const tokensOf = (n: Node): [string, string][] => {
  const color = String(n.properties?.style ?? "").match(
    /--diffs-token-dark:(#\w+)/
  )?.[1];
  if (color && n.children?.every((c) => c.type === "text"))
    return [[textOf(n), color]];
  return (n.children ?? []).flatMap(tokensOf);
};

/** Every line Pierre renders; context lines appear once per side. */
function render(fileDiff: FileDiffMetadata, expandedHunks?: true): Row[] {
  const { code } = renderDiffWithHighlighter(
    fileDiff,
    highlighter,
    {
      theme: DIFF_THEMES,
      useTokenTransformer: false,
      tokenizeMaxLineLength: 1000,
      lineDiffType: "word-alt",
      maxLineDiffLength: 1000,
    },
    { forcePlainText: false, expandedHunks }
  );
  const sides = [
    ["old", code.deletionLines],
    ["new", code.additionLines],
  ] as const;
  return sides.flatMap(([side, nodes]) =>
    (nodes as Node[]).map((n) => {
      const p = n.properties!;
      const [unified, split] = String(p["data-line-index"])
        .split(",")
        .map(Number);
      return {
        side,
        line: Number(p["data-line"]),
        type: String(p["data-line-type"]),
        text: textOf(n).replace(/\n$/, ""),
        spans: spansOf(n),
        tokens: tokensOf(n),
        unified: unified!,
        split: split!,
      };
    })
  );
}

const isContext = (row: Row) => row.type.startsWith("context");

/** Unified view, top to bottom: context lines once, then -/+ lines. */
function unifiedRows(rows: Row[]): Row[] {
  return rows
    .filter((r) => !(isContext(r) && r.side === "old"))
    .sort((a, b) => a.unified - b.unified);
}

/** Split view, top to bottom, as [old, new] cells. */
function splitRows(rows: Row[]): [Row | undefined, Row | undefined][] {
  const bySplit = new Map<number, [Row | undefined, Row | undefined]>();
  for (const row of rows) {
    const cells = bySplit.get(row.split) ?? [undefined, undefined];
    cells[row.side === "old" ? 0 : 1] = row;
    bySplit.set(row.split, cells);
  }
  return [...bySplit].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells);
}

/** A hunk-only patch from raw ` `/`-`/`+` lines, with a correct header. */
function patchOf(oldStart: number, newStart: number, lines: string[]): string {
  const oldCount = lines.filter((l) => l[0] !== "+").length;
  const newCount = lines.filter((l) => l[0] !== "-").length;
  return [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...lines,
  ].join("\n");
}

function renderPatch(patch: string, filename = "file.txt"): Row[] {
  return render(fileDiffFromPatch({ patch, filename }));
}

function expectMonotonicGutters(rows: Row[]) {
  for (const side of ["old", "new"] as const) {
    const unified = unifiedRows(rows)
      .filter((r) => r.side === side || isContext(r))
      .map((r) => (r.side === side ? r.line : undefined));
    const numbers = unified.filter((n) => n !== undefined);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    const split = splitRows(rows).flatMap(
      ([o, n]) => (side === "old" ? o : n)?.line ?? []
    );
    expect(split).toEqual([...split].sort((a, b) => a - b));
  }
}

const cell = (row: Row | undefined) =>
  row ? `${row.line} ${row.text}` : undefined;

const importSrpmPatch = readFileSync(
  new URL("./fixtures/import-srpm.patch", import.meta.url),
  "utf8"
).trimEnd();

test("gutters never go backwards, in unified and split views", () => {
  const corpus = [
    // xcp-ng/xcp-ng-tests PR 658: a decorator added above a modified signature.
    patchOf(75, 75, [
      "     def test_drivers_detected(self, vm: VM) -> None:",
      "         pass",
      " ",
      "-    def test_vif_replug(self, vm: VM) -> None:",
      '+    @pytest.mark.parametrize("force", (False, True))',
      "+    def test_vif_replug(self, vm: VM, force: bool) -> None:",
      "         vm = vm_install_test_tools_per_test_class",
      "-                vif.unplug()",
      "+                vif.unplug(force=force)",
      "         # HACK: Allow some time for the unplug to settle.",
    ]),
    patchOf(1, 1, [" A", "-foo bar", " C", "+foo baz", " D"]),
    patchOf(1, 1, [" context1", "-apple", "-banana", "+cherry", "+date"]),
    patchOf(1, 1, [
      " context1",
      "-hello world",
      "+hello_world",
      "-standalone",
      "-foo bar",
      "+foo baz",
      " context2",
    ]),
    patchOf(1, 1, ["-foo", "-bar", "-baz", "+bar", "+baz", "+foo"]),
    importSrpmPatch,
  ];
  for (const patch of corpus) expectMonotonicGutters(renderPatch(patch));
});

test("a decorator added above a modified line comes first, and the line pairs with its new version", () => {
  const rows = renderPatch(
    patchOf(75, 75, [
      "     pass",
      "-    def test_vif_replug(self, vm: VM) -> None:",
      '+    @pytest.mark.parametrize("force", (False, True))',
      "+    def test_vif_replug(self, vm: VM, force: bool) -> None:",
      "         vm = vm_install",
      "-                vif.unplug()",
      "+                vif.unplug(force=force)",
    ]),
    "test.py"
  );
  const order = unifiedRows(rows).map((r) => `${r.side} ${r.line}`);
  expect(order.indexOf("new 76")).toBeLessThan(order.indexOf("new 77"));
  const split = splitRows(rows);
  expect(split.map(([o, n]) => [o?.line, n?.line])).toEqual([
    [75, 75],
    [undefined, 76],
    [76, 77],
    [77, 78],
    [78, 79],
  ]);
  expect(split[2]![1]!.spans).toEqual([", force: bool"]);
  expect(split[4]![1]!.spans).toEqual(["force=force"]);
});

test("a change pairs with the line it replaces, not one from another section", () => {
  // A new function taking `x` is added above an existing function whose `x`
  // becomes `y`: the removed `x` pairs with `y`, not with the new function's `x`.
  const rows = renderPatch(
    patchOf(1, 1, [
      " context1",
      "+def new_func(",
      "+    x: str,",
      "+):",
      " def existing_func(",
      "-    x: str,",
      "+    y: str,",
      "     other: str,",
    ]),
    "file.py"
  );
  const split = splitRows(rows);
  const changed = split.find(([o]) => o?.text === "    x: str,")!;
  expect(cell(changed[1])).toBe("6     y: str,");
  expect(changed[0]!.spans).toEqual(["x"]);
  expect(changed[1]!.spans).toEqual(["y"]);
  const added = split.find(([, n]) => n?.line === 3)!;
  expect(added[0]).toBeUndefined();
});

test("lines far from their old position still pair and get a word diff", () => {
  for (const [from, to, changed] of [
    ["%package -n python2-perf", "%package -n python3-perf", "python"],
    ["%{python2_sitearch}/*", "%{python3_sitearch}/*", "sitearch"],
  ]) {
    const rows = renderPatch(
      patchOf(780, 183, [" context", `-${from}`, `+${to}`, " context"]),
      "kernel.spec"
    );
    const split = splitRows(rows);
    expect(split.map(([o, n]) => [o?.line, n?.line])).toEqual([
      [780, 183],
      [781, 184],
      [782, 185],
    ]);
    const [old, current] = split[1]!;
    expect(old!.spans.join("")).toContain(changed);
    expect(current!.spans.join("")).toContain(changed);
    expect(old!.spans.join("")).not.toContain("%");
  }
});

test("a delete and an insert split by context stay on separate rows", () => {
  const rows = renderPatch(
    patchOf(1, 1, [" A", "-foo bar", " C", "+foo baz", " D"])
  );
  expect(unifiedRows(rows).map((r) => r.text)).toEqual([
    "A",
    "foo bar",
    "C",
    "foo baz",
    "D",
  ]);
  expect(splitRows(rows).map(([o, n]) => [cell(o), cell(n)])).toEqual([
    ["1 A", "1 A"],
    ["2 foo bar", undefined],
    ["3 C", "2 C"],
    [undefined, "3 foo baz"],
    ["4 D", "4 D"],
  ]);
});

test("leading deletions stay before the following context", () => {
  const rows = renderPatch(
    "@@ -1,7 +1,4 @@\n-base_1\n-base_2\n-base_3\n base_4\n base_5\n base_6\n base_7"
  );
  const unified = unifiedRows(rows);
  expect(unified.map((r) => r.text)).toEqual(
    Array.from({ length: 7 }, (_, i) => `base_${i + 1}`)
  );
  expect(unified.flatMap((r) => (r.side === "new" ? r.line : []))).toEqual([
    1, 2, 3, 4,
  ]);
  expect(splitRows(rows).map(([o]) => o?.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("each old line shows its own content when a block is restructured", () => {
  // xcp-ng-pv-tools.spec: lines moved within the block are not merged with
  // their copies elsewhere, and old 241 is not shown again on other rows.
  const rows = renderPatch(
    patchOf(238, 238, [
      " install -m 0644 %{SOURCE1} iso/README.txt",
      " unzip %{SOURCE100} '*/package/*'",
      " cp -r -T %{winpv_version_x64}/package iso/Windows",
      "-install -m 0644 versions.tgz versions.rpm versions.deb iso/Linux/",
      "-install -m 0755 mk/install.sh \\",
      "-                mk/xe-linux-distribution \\",
      "+install -m 0644 versions.tgz \\",
      "+                versions.rpm \\",
      "+                versions.deb \\",
      "                 mk/xe-linux-distribution.service \\",
      "                 mk/xen-vcpu-hotplug.rules \\",
      "-                LICENSE \\",
      "+                LICENSE",
      "+install -m 0755 mk/install.sh \\",
      "+                mk/xe-linux-distribution \\",
      "                 iso/Linux/",
      " ",
      " genisoimage -joliet -joliet-long -r \\",
    ]),
    "xcp-ng-pv-tools.spec"
  );
  expectMonotonicGutters(rows);
  const old = new Map(
    rows.filter((r) => r.side === "old").map((r) => [r.line, r.text])
  );
  expect(old.get(242)).toBe("install -m 0755 mk/install.sh \\");
  expect(old.get(243)).toBe("                mk/xe-linux-distribution \\");
  expect(
    rows.filter((r) => r.text.includes("versions.rpm versions.deb"))
  ).toHaveLength(1);
  const moved = rows.filter(
    (r) => r.text === "install -m 0755 mk/install.sh \\"
  );
  expect(moved.map((r) => [r.side, r.type])).toEqual([
    ["old", "change-deletion"],
    ["new", "change-addition"],
  ]);
});

test("indentation-only changes pair in a large rewrite", () => {
  // scripts/import_srpm.py: a re-indented `try:`/`except` pair lines up with
  // its new version.
  const split = splitRows(renderPatch(importSrpmPatch, "import_srpm.py"));
  const at = (line: number) => split.find(([o]) => o?.line === line)!;
  expect(cell(at(139)[1])).toBe("160         try:");
  expect(cell(at(141)[1])).toBe("162         except Exception:");
  expect(cell(at(80)[1])).toBe("102         try:");
  expect(cell(at(83)[1])).toBe("105         except Exception:");
});

test("pairing survives hydration, and split row counts match the rendered rows", () => {
  const partial = fileDiffFromPatch({
    filename: "file.txt",
    patch: [
      patchOf(2, 2, [
        " context1",
        "-hello world",
        "+hello_world",
        "-standalone",
        "-foo bar",
        "+foo baz",
        " context2",
      ]),
      patchOf(20, 19, [" a", "-x1", "-same line", "+same line!", "+y1", " b"]),
    ].join("\n"),
  });
  const lines = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
  const oldContent = [
    "top",
    "context1",
    "hello world",
    "standalone",
    "foo bar",
    "context2",
    ...lines(13, "k"),
    "a",
    "x1",
    "same line",
    "b",
    "",
  ].join("\n");
  const newContent = [
    "top",
    "context1",
    "hello_world",
    "foo baz",
    "context2",
    ...lines(13, "k"),
    "a",
    "same line!",
    "y1",
    "b",
    "",
  ].join("\n");
  const hydrated = hydratePartialDiff("clone", partial, {
    oldFile: { name: "file.txt", contents: oldContent },
    newFile: { name: "file.txt", contents: newContent },
  });
  for (const [fileDiff, expanded] of [
    [partial, undefined],
    [hydrated, true],
  ] as const) {
    const split = splitRows(render(fileDiff, expanded));
    const pair = (text: string) =>
      split.find(([o]) => o?.text === text)?.[1]?.text;
    expect(pair("hello world")).toBe("hello_world");
    expect(pair("standalone")).toBeUndefined();
    expect(pair("foo bar")).toBe("foo baz");
    expect(pair("x1")).toBeUndefined();
    expect(pair("same line")).toBe("same line!");
    const rendered = split.length;
    const counted = fileDiff.hunks.reduce((n, h) => n + h.splitLineCount, 0);
    if (!expanded) expect(counted).toBe(rendered);
    else expect(fileDiff.splitLineCount).toBe(rendered);
  }
});

test("split view pairs similar lines when a deletion has no match", () => {
  const split = splitRows(
    renderPatch(
      patchOf(1, 1, [
        " context1",
        "-hello world",
        "+hello_world",
        "-standalone",
        "-foo bar",
        "+foo baz",
        " context2",
      ])
    )
  );
  expect(split.map(([o, n]) => [o?.text, n?.text])).toEqual([
    ["context1", "context1"],
    ["hello world", "hello_world"],
    ["standalone", undefined],
    ["foo bar", "foo baz"],
    ["context2", "context2"],
  ]);
});

test("rendered text keeps all whitespace, and word diffs leave the indent out", () => {
  // xcp-ng/xcp-ng-tests#570 lib/host.py
  const before =
    "        cmd = 'yum install --setopt=skip_missing_names_on_install=False -y'";
  const after =
    "        opts = '--setopt=skip_missing_names_on_install=False' if self.pm == 'yum' else ''";
  const rows = renderPatch(
    patchOf(1, 1, [`-${before}`, `+${after}`]),
    "host.py"
  );
  const [[old, current]] = splitRows(rows) as [[Row, Row]];
  expect(old.text).toBe(before);
  expect(current.text).toBe(after);
  for (const row of [old, current]) {
    expect(row.spans.length).toBeGreaterThan(0);
    for (const span of row.spans)
      expect(span.startsWith("        ")).toBe(false);
  }
});

test("empty lines replaced by empty lines pair on one row", () => {
  const rows = renderPatch(patchOf(1, 1, [" one", "-", "+", " two"]));
  expect(splitRows(rows).map(([o, n]) => [cell(o), cell(n)])).toEqual([
    ["1 one", "1 one"],
    ["2 ", "2 "],
    ["3 two", "3 two"],
  ]);
});

test("rotated lines keep both gutters in order", () => {
  const rows = renderPatch(
    patchOf(1, 1, ["-foo", "-bar", "-baz", "+bar", "+baz", "+foo"])
  );
  expectMonotonicGutters(rows);
  expect(unifiedRows(rows).map((r) => `${r.side} ${r.text}`)).toEqual([
    "old foo",
    "old bar",
    "old baz",
    "new bar",
    "new baz",
    "new foo",
  ]);
});

const colorOf = (row: Row, text: string) =>
  row.tokens.find(([t]) => t.includes(text))?.[1];

test("a hunk starting after a closing raw string highlights code as code", () => {
  // The hunk's first line `"#;` closes a raw string opened above the hunk; it
  // must not be read as opening one that swallows the code below it.
  const newContent = [
    "fn earlier() {",
    '    let s = r#"',
    "        multi",
    "        line",
    '    "#;',
    "}",
    "#[test]",
    "fn later() {",
    "    // a comment",
    '    let x = "world";',
    "}",
    "",
  ].join("\n");
  const oldContent = newContent.replace('    let x = "world";\n', "");
  const partial = fileDiffFromPatch({
    filename: "test.rs",
    patch: patchOf(5, 5, [
      '     "#;',
      " }",
      " #[test]",
      " fn later() {",
      "     // a comment",
      '+    let x = "world";',
      " }",
    ]),
  });
  const hydrated = hydratePartialDiff("clone", partial, {
    oldFile: { name: "test.rs", contents: oldContent },
    newFile: { name: "test.rs", contents: newContent },
  });
  for (const fileDiff of [partial, hydrated]) {
    const rows = render(fileDiff).filter((r) => r.side === "new");
    const comment = rows.find((r) => r.text.includes("a comment"))!;
    const added = rows.find((r) => r.text.includes("world"))!;
    const fn = rows.find((r) => r.text.startsWith("fn later"))!;
    expect(colorOf(comment, "a comment")).not.toBe(colorOf(added, "world"));
    expect(colorOf(fn, "fn")).not.toBe(colorOf(added, "world"));
    expect(colorOf(added, "let")).toBe(colorOf(fn, "fn"));
  }
});

test("a word diff inside a block comment keeps the comment's color", () => {
  const oldContent = [
    "# T",
    "",
    "<!--",
    "a hidden note",
    "with old words",
    "-->",
    "",
    "text",
    "",
  ].join("\n");
  const newContent = oldContent.replace("old words", "new words");
  const partial = fileDiffFromPatch({
    filename: "notes.md",
    patch: patchOf(2, 2, [
      " ",
      " <!--",
      " a hidden note",
      "-with old words",
      "+with new words",
      " -->",
      " ",
      " text",
    ]),
  });
  const hydrated = hydratePartialDiff("clone", partial, {
    oldFile: { name: "notes.md", contents: oldContent },
    newFile: { name: "notes.md", contents: newContent },
  });
  for (const fileDiff of [partial, hydrated]) {
    const rows = render(fileDiff);
    const note = rows.find(
      (r) => r.side === "new" && r.text === "a hidden note"
    )!;
    const comment = colorOf(note, "hidden");
    for (const [side, word] of [
      ["old", "old"],
      ["new", "new"],
    ] as const) {
      const row = rows.find((r) => r.side === side && r.spans.includes(word))!;
      expect(colorOf(row, word)).toBe(comment);
    }
    const text = rows.find((r) => r.side === "new" && r.text === "text")!;
    expect(colorOf(text, "text")).not.toBe(comment);
  }
});

test("a comparison of two versions reconstructs both files, repeated replacements included", () => {
  const oldContent = "shared\nkeep\nbase\n";
  const newContent = "base\nkeep\nshared\n";
  const fileDiff = hydratePartialDiff(
    "clone",
    fileDiffFromPatch({
      filename: "file.txt",
      patch: patchOf(1, 1, ["-shared", "+base", " keep", "-base", "+shared"]),
    }),
    {
      oldFile: { name: "file.txt", contents: oldContent },
      newFile: { name: "file.txt", contents: newContent },
    }
  );
  const rows = render(fileDiff, true);
  for (const [side, contents] of [
    ["old", oldContent],
    ["new", newContent],
  ] as const) {
    const lines = rows
      .filter((r) => r.side === side)
      .sort((a, b) => a.line - b.line)
      .map((r) => r.text);
    expect(lines.join("\n") + "\n").toBe(contents);
  }
});

test("expanding a comparison shows each side's own lines and numbers in the gap", () => {
  // A line inserted above the gap shifts it: old lines 2-6 are new lines 3-7.
  const shared = ["k1", "k2", "k3", "k4", "k5"];
  const oldContent = ["one", ...shared, "tail-old", ""].join("\n");
  const newContent = ["one", "inserted", ...shared, "tail-new", ""].join("\n");
  const fileDiff = hydratePartialDiff(
    "clone",
    fileDiffFromPatch({
      filename: "file.txt",
      patch: [
        patchOf(1, 1, [" one", "+inserted"]),
        patchOf(7, 8, ["-tail-old", "+tail-new"]),
      ].join("\n"),
    }),
    {
      oldFile: { name: "file.txt", contents: oldContent },
      newFile: { name: "file.txt", contents: newContent },
    }
  );
  const rows = render(fileDiff, true);
  expect(
    splitRows(rows)
      .filter(([o]) => o?.text.startsWith("k"))
      .map(([o, n]) => [cell(o), cell(n)])
  ).toEqual(shared.map((k, i) => [`${i + 2} ${k}`, `${i + 3} ${k}`]));
  expectMonotonicGutters(rows);
});
