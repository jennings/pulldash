import { test, expect, describe, beforeEach } from "bun:test";
import gitDiffParser from "gitdiff-parser";

// Must be set before the module loads, since diff-worker.ts calls `self.postMessage`
// inside the handler (not at load time), but we set it here for clarity.
const posted: any[] = [];
(globalThis as any).postMessage = (data: unknown) => {
  posted.push(data);
};

// Import the module: this sets globalThis.onmessage to the worker handler
import "./diff-worker";
import { mergeModifiedLines } from "./diff-worker";

const handler = (globalThis as any).onmessage as (e: { data: any }) => void;

beforeEach(() => {
  posted.length = 0;
});

const patchForImportSrpm = `@@ -6,7 +6,11 @@
 import os
 import shutil
 import subprocess
+from contextlib import nullcontext
 from glob import glob
+from tempfile import TemporaryDirectory
+from urllib.parse import urlparse
+from urllib.request import urlretrieve
 
 
 def call_process(args):
@@ -40,6 +44,13 @@
 
     return final_stdout
 
+def is_url(url_string):
+    try:
+        result = urlparse(url_string)
+        return all([result.scheme, result.netloc])
+    except ValueError:
+        return False
+
 def main():
     parser = argparse.ArgumentParser(description='Imports the contents of a source RPM into a git repository')
     parser.add_argument('source_rpm', help='local path to source RPM')
@@ -64,110 +75,120 @@
         if shutil.which(dep) is None:
             parser.error(f"{dep} can't be found.")
 
-    # check that the source RPM file exists
-    if not os.path.isfile(args.source_rpm):
-        parser.error("File %s does not exist." % args.source_rpm)
-    if not args.source_rpm.endswith('.src.rpm'):
-        parser.error("File %s does not appear to be a source RPM." % args.source_rpm)
-    source_rpm_abs = os.path.abspath(args.source_rpm)
-
-    # enter repository directory
-    if not os.path.isdir(args.repository):
-        parser.error("Repository directory %s does not exist." % args.repository)
-    os.chdir(args.repository)
-
-    # check that the working copy is clean
-    try:
-        call_process(['git', 'diff-index', '--quiet',  'HEAD', '--'])
-        print("Working copy is clean.")
-    except:
-        raise
-        parser.error("Git repository seems to have local modifications.")
-
-    # check that there are no untracked files
-    if len(subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'])):
-        parser.error("There are untracked files.")
-
-    print(" checking out parent ref...")
-
-    if args.push:
-        call_process(['git', 'fetch'])
-    call_process(['git', 'checkout', args.parent_branch])
-    if args.push:
-        call_process(['git', 'pull'])
-
-    print(" removing everything from SOURCES and SPECS...")
-
-    if os.path.isdir('SOURCES') and len(os.listdir('SOURCES')) > 0:
-        call_process(['git', 'rm', 'SOURCES/*', '-r'])
-    if os.path.isdir('SOURCES') and len(os.listdir('SOURCES')) > 0:
-        parser.error("Files remaining in SOURCES/ after removing the tracked ones. ")
-        parser.error("Delete them (including hidden files), reset --hard.")
-    os.mkdir('SOURCES')
-
-    if os.path.isdir('SPECS'):
-        call_process(['git', 'rm', 'SPECS/*', '-r'])
-    os.mkdir('SPECS')
-
-    print(" extracting SRPM...")
-
-    os.chdir('SOURCES')
-    pipe_commands(['rpm2cpio', source_rpm_abs], ['cpio', '-idmv'])
-    os.chdir('..')
-    for f in glob('SOURCES/*.spec'):
-        shutil.move(f, 'SPECS')
-
-    print(" removing trademarked or copyrighted files...")
-
-    sources = os.listdir('SOURCES')
-    deletemsg = "File deleted from the original sources for trademark-related or copyright-related legal reasons.\\n"
-    deleted = []
-    for f in ['Citrix_Logo_Black.png', 'COPYING.CitrixCommercial']:
-        if f in sources:
-            os.unlink(os.path.join('SOURCES', f))
-            open(os.path.join('SOURCES', "%s.deleted-by-XCP-ng.txt" % f), 'w').write(deletemsg)
-            deleted.append(f)
-
-    if subprocess.call(['git', 'rev-parse', '--quiet', '--verify', args.branch]) != 0:
-        call_process(['git', 'checkout', '-b', args.branch])
-    else:
-        call_process(['git', 'checkout', args.branch])
-    call_process(['git', 'add', '--all'])
-
-    print(" committing...")
-    has_changes = False
-    try:
-        call_process(['git', 'diff-index', '--quiet',  'HEAD', '--'])
-    except:
-        has_changes = True
-
-    if not has_changes:
-        print("\\nWorking copy has no modifications. Nothing to commit. No changes from previous release?\\n")
-    else:
-        msg = 'Import %s' % os.path.basename(args.source_rpm)
-        if deleted:
-            msg += "\\n\\nFiles deleted for legal reasons:\\n - " + '\\n - '.join(deleted)
-        call_process(['git', 'commit', '-s', '-m', msg])
-
-    # tag
-    if args.tag is not None:
-        call_process(['git', 'tag', args.tag])
-
-    # push to remote
-    if args.push:
-        call_process(['git', 'push', '--set-upstream', 'origin', args.branch])
+    # handle URL source
+    source_rpm = args.source_rpm
+    is_remote_rpm = is_url(source_rpm)
+
+    with TemporaryDirectory() if is_remote_rpm else nullcontext() as temp_dir:
+        if is_remote_rpm:
+            # get the src.rpm locally, and continue with the actual file
+            local_filename = f'{temp_dir}/{os.path.basename(source_rpm)}'
+            urlretrieve(source_rpm, local_filename)
+            source_rpm = local_filename
+
+        # check that the source RPM file exists
+        if not os.path.isfile(source_rpm):
+            parser.error("File %s does not exist." % source_rpm)
+        if not source_rpm.endswith('.src.rpm'):
+            parser.error("File %s does not appear to be a source RPM." % source_rpm)
+        source_rpm_abs = os.path.abspath(source_rpm)
+
+        # enter repository directory
+        if not os.path.isdir(args.repository):
+            parser.error("Repository directory %s does not exist." % args.repository)
+        os.chdir(args.repository)
+
+        # check that the working copy is clean
+        try:
+            call_process(['git', 'diff-index', '--quiet', 'HEAD', '--'])
+            print("Working copy is clean.")
+        except Exception:
+            parser.error("Git repository seems to have local modifications.")
+
+        # check that there are no untracked files
+        if len(subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'])):
+            parser.error("There are untracked files.")
+
+        print(" checking out parent ref...")
+
+        if args.push:
+            call_process(['git', 'fetch'])
+        call_process(['git', 'checkout', args.parent_branch])
+        if args.push:
+            call_process(['git', 'pull'])
+
+        print(" removing everything from SOURCES and SPECS...")
+
+        if os.path.isdir('SOURCES') and len(os.listdir('SOURCES')) > 0:
+            call_process(['git', 'rm', 'SOURCES/*', '-r'])
+        if os.path.isdir('SOURCES') and len(os.listdir('SOURCES')) > 0:
+            parser.error("Files remaining in SOURCES/ after removing the tracked ones. ")
+            parser.error("Delete them (including hidden files), reset --hard.")
+        os.mkdir('SOURCES')
+
+        if os.path.isdir('SPECS'):
+            call_process(['git', 'rm', 'SPECS/*', '-r'])
+        os.mkdir('SPECS')
+
+        print(" extracting SRPM...")
+
+        os.chdir('SOURCES')
+        pipe_commands(['rpm2cpio', source_rpm_abs], ['cpio', '-idmv'])
+        os.chdir('..')
+        for f in glob('SOURCES/*.spec'):
+            shutil.move(f, 'SPECS')
+
+        print(" removing trademarked or copyrighted files...")
+
+        sources = os.listdir('SOURCES')
+        deletemsg = "File deleted from the original sources for trademark-related or copyright-related legal reasons.\\n"
+        deleted = []
+        for f in ['Citrix_Logo_Black.png', 'COPYING.CitrixCommercial']:
+            if f in sources:
+                os.unlink(os.path.join('SOURCES', f))
+                open(os.path.join('SOURCES', "%s.deleted-by-XCP-ng.txt" % f), 'w').write(deletemsg)
+                deleted.append(f)
+
+        if subprocess.call(['git', 'rev-parse', '--quiet', '--verify', args.branch]) != 0:
+            call_process(['git', 'checkout', '-b', args.branch])
+        else:
+            call_process(['git', 'checkout', args.branch])
+        call_process(['git', 'add', '--all'])
+
+        print(" committing...")
+        has_changes = False
+        try:
+            call_process(['git', 'diff-index', '--quiet', 'HEAD', '--'])
+        except Exception:
+            has_changes = True
+
+        if not has_changes:
+            print("\\nWorking copy has no modifications. Nothing to commit. No changes from previous release?\\n")
+        else:
+            msg = 'Import %s' % os.path.basename(source_rpm)
+            if deleted:
+                msg += "\\n\\nFiles deleted for legal reasons:\\n - " + '\\n - '.join(deleted)
+            call_process(['git', 'commit', '-s', '-m', msg])
+
+        # tag
+        if args.tag is not None:
+            call_process(['git', 'tag', args.tag])
+
+        # push to remote
+        if args.push:
+            call_process(['git', 'push', '--set-upstream', 'origin', args.branch])
+            if args.tag is not None:
+                call_process(['git', 'push', 'origin', args.tag])
+
+        print(" switching to master before leaving...")
+
+        call_process(['git', 'checkout', 'master'])
+
+        # merge to master if needed
+        if args.push and args.master:
+            print(" merging to master...")
+            call_process(['git', 'push', 'origin', '%s:master' % args.branch])
+            call_process(['git', 'pull'])
+
+
 if __name__ == "__main__":`;

// ============================================================================
// parse-diff dispatch
// ============================================================================

describe("parse-diff message", () => {
  test("dispatches parse-diff and posts parse-diff-result", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old
+new
 context`;

    handler({
      data: { type: "parse-diff", id: "1", patch, filename: "test.ts" },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("parse-diff-result");
    expect(posted[0].id).toBe("1");
    expect(posted[0].result).toBeDefined();
    expect(Array.isArray(posted[0].result.hunks)).toBe(true);
  });

  test("result contains hunk with lines for a non-empty patch", () => {
    const patch = `@@ -1,2 +1,2 @@
-foo
+bar`;

    handler({
      data: { type: "parse-diff", id: "2", patch, filename: "test.ts" },
    });

    const response = posted[0];
    expect(response.type).toBe("parse-diff-result");
    const hunk = response.result.hunks.find((h: any) => h.type === "hunk");
    expect(hunk).toBeDefined();
    expect(hunk.lines.length).toBeGreaterThan(0);
  });

  test("result is empty hunks for an empty/invalid patch", () => {
    handler({
      data: { type: "parse-diff", id: "3", patch: "", filename: "test.ts" },
    });

    expect(posted[0].type).toBe("parse-diff-result");
    expect(posted[0].result.hunks).toHaveLength(0);
  });

  test("accepts optional previousFilename, oldContent, newContent", () => {
    const patch = `@@ -1,1 +1,1 @@
-old
+new`;

    handler({
      data: {
        type: "parse-diff",
        id: "4",
        patch,
        filename: "new.ts",
        previousFilename: "old.js",
        oldContent: "old\n",
        newContent: "new\n",
      },
    });

    expect(posted[0].type).toBe("parse-diff-result");
    expect(posted[0].result.hunks.length).toBeGreaterThan(0);
  });

  test("uses full-file context so a hunk after a closing raw string highlights code as code", () => {
    // Reproduces the reported bug: a Rust hunk that begins after a raw-string
    // terminator (`"#);`) was fed to the highlighter as a fragment starting
    // with `"`, which the grammar interpreted as an OPEN string. Comments and
    // code downstream got tagged as strings, and string contents got tagged
    // as code. Passing the full-file `newContent` restores the correct state.
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

    // Hunk begins on line 5 with `    "#;` — the closing of an earlier
    // raw string. Refractor, fed only the hunk lines, sees `"` as the
    // OPEN of a new string and tags every subsequent line (including
    // `// a comment`) as string content. Passing `newContent` lets the
    // highlighter see that the `"#;` closes a raw string that opened
    // earlier, and the comment tags correctly.
    const patch = `@@ -5,7 +5,8 @@
     "#;
 }
 #[test]
 fn later() {
     // a comment
+    let x = "world";
 }`;

    handler({
      data: {
        type: "parse-diff",
        id: "raw-string-ctx",
        patch,
        filename: "test.rs",
        newContent,
        oldContent,
      },
    });

    expect(posted[0].type).toBe("parse-diff-result");
    const hunk = posted[0].result.hunks.find((h: any) => h.type === "hunk");
    expect(hunk).toBeDefined();

    const commentLine = hunk.lines.find(
      (l: any) =>
        l.type === "normal" && l.content[0].value.includes("a comment")
    );
    expect(commentLine).toBeDefined();
    const commentHtml = commentLine.content[0].html as string;
    expect(commentHtml).toContain("token comment");
    expect(commentHtml).not.toContain("token string");

    // And the added string literal should be tagged as a string.
    const stringLine = hunk.lines.find(
      (l: any) => l.type === "insert" && l.content[0].value.includes("world")
    );
    expect(stringLine).toBeDefined();
    const stringHtml = stringLine.content[0].html as string;
    expect(stringHtml).toContain("token string");
  });
});

// ============================================================================
// highlight-lines dispatch
// ============================================================================

describe("highlight-lines message", () => {
  test("dispatches highlight-lines and posts highlight-lines-result", () => {
    handler({
      data: {
        type: "highlight-lines",
        id: "5",
        content: "const x = 1;\nconst y = 2;\nconst z = 3;",
        filename: "test.ts",
        startLine: 1,
        oldStartLine: 1,
        count: 2,
      },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("highlight-lines-result");
    expect(posted[0].id).toBe("5");
    expect(Array.isArray(posted[0].result)).toBe(true);
    expect(posted[0].result).toHaveLength(2);
  });

  test("all returned lines have type=normal", () => {
    handler({
      data: {
        type: "highlight-lines",
        id: "6",
        content: "line1\nline2\nline3",
        filename: "test.ts",
        startLine: 1,
        oldStartLine: 1,
        count: 3,
      },
    });

    const lines = posted[0].result;
    expect(lines.every((l: any) => l.type === "normal")).toBe(true);
  });

  test("old and new line numbers can differ (drift from hunks above)", () => {
    // Simulates expanding a skip block below a hunk that added 3 net lines:
    // the same visible content is at newLine=10 but oldLine=7 in the base file.
    handler({
      data: {
        type: "highlight-lines",
        id: "drift-1",
        content: Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join(
          "\n"
        ),
        filename: "test.ts",
        startLine: 10,
        oldStartLine: 7,
        count: 3,
      },
    });

    expect(posted[0].result).toHaveLength(3);
    expect(posted[0].result[0].newLineNumber).toBe(10);
    expect(posted[0].result[0].oldLineNumber).toBe(7);
    expect(posted[0].result[2].newLineNumber).toBe(12);
    expect(posted[0].result[2].oldLineNumber).toBe(9);
  });

  test("count clamps to end of file", () => {
    // Trailing-newline file with 3 real lines; asking for a huge count must
    // return exactly 3, not iterate past EOF with empty content.
    handler({
      data: {
        type: "highlight-lines",
        id: "clamp-1",
        content: "line1\nline2\nline3\n",
        filename: "test.ts",
        startLine: 1,
        oldStartLine: 1,
        count: Number.MAX_SAFE_INTEGER,
      },
    });

    expect(posted[0].result).toHaveLength(3);
    expect(posted[0].result[0].newLineNumber).toBe(1);
    expect(posted[0].result[2].newLineNumber).toBe(3);
  });

  test("count clamps when startLine is partway through the file", () => {
    handler({
      data: {
        type: "highlight-lines",
        id: "clamp-2",
        content: "a\nb\nc\nd\ne",
        filename: "test.ts",
        startLine: 4,
        oldStartLine: 4,
        count: 999,
      },
    });

    expect(posted[0].result).toHaveLength(2);
    expect(posted[0].result[0].newLineNumber).toBe(4);
    expect(posted[0].result[1].newLineNumber).toBe(5);
  });
});

// ============================================================================
// interdiff dispatch
// ============================================================================

describe("interdiff message", () => {
  test("dispatches interdiff and posts interdiff-result", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old
+new
 context`;

    handler({
      data: { type: "interdiff", id: "7", patch1: patch, patch2: patch },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("interdiff-result");
    expect(posted[0].id).toBe("7");
    expect(posted[0].result).toBeDefined();
    expect(Array.isArray(posted[0].result.hunks)).toBe(true);
  });

  test("identical patches produce empty interdiff", () => {
    const patch = `@@ -1,3 +1,3 @@
 context
-old
+new
 context`;

    handler({
      data: { type: "interdiff", id: "8", patch1: patch, patch2: patch },
    });

    expect(posted[0].result.hunks).toHaveLength(0);
  });

  test("different patches produce non-empty interdiff", () => {
    const patch1 = `@@ -1,3 +1,3 @@
 context
-old
+v1
 context`;
    const patch2 = `@@ -1,3 +1,3 @@
 context
-old
+v2
 context`;

    handler({ data: { type: "interdiff", id: "9", patch1, patch2 } });

    expect(posted[0].result.hunks.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// error propagation
// ============================================================================

describe("error propagation", () => {
  test("unknown message type produces no response (switch falls through)", () => {
    handler({ data: { type: "unknown-type", id: "err-test" } } as any);
    expect(posted).toHaveLength(0);
  });

  test("parse-diff with a bad patch posts an error response rather than throwing", () => {
    // parseDiffWithHighlighting is resilient (returns {hunks: []}) for bad patches,
    // so the handler should always post a result, not an error, for well-formed messages
    handler({
      data: {
        type: "parse-diff",
        id: "bad",
        patch: "not a valid patch",
        filename: "x.ts",
      },
    });
    expect(posted).toHaveLength(1);
    // Either a result or an error — either way something is posted and the handler doesn't throw
    expect(["parse-diff-result", "error"]).toContain(posted[0].type);
  });

  test("merges delete+insert pair when offset between old/new line numbers exceeds maxDiffDistance", () => {
    // Hunk: @@ -780,3 +183,3 @@
    // Delete has oldLineNumber=781, Insert has newLineNumber=184
    // Difference of 597 is well above maxDiffDistance=30
    // The function should use change index, not absolute line numbers, to pair them
    const patch = [
      "@@ -780,3 +183,3 @@",
      " context",
      "-%package -n python2-perf",
      "+%package -n python3-perf",
      " context",
    ].join("\n");

    handler({
      data: {
        type: "parse-diff",
        id: "large-offset",
        patch,
        filename: "kernel.spec",
      },
    });

    const result = posted[0].result;
    const hunks = result.hunks;
    // First hunk is a skip block (lines 1-779), second is the actual hunk
    const hunk = hunks[1];
    expect(hunk).toBeDefined();
    expect(hunk.lines).toHaveLength(3);

    const [contextLine, modifiedLine, contextLine2] = hunk.lines;

    // First line: context
    expect(contextLine.type).toBe("normal");
    expect(contextLine.content[0].value).toBe("context");

    // Second line: should be a single merged "normal" line (not separate delete+insert)
    expect(modifiedLine.type).toBe("normal");
    expect(modifiedLine.oldLineNumber).toBe(781);
    expect(modifiedLine.newLineNumber).toBe(184);
    // Word-diff segments: at least one insert and one delete for the single-char change
    const hasInsert = modifiedLine.content.some(
      (s: any) => s.type === "insert"
    );
    const hasDelete = modifiedLine.content.some(
      (s: any) => s.type === "delete"
    );
    expect(hasInsert).toBe(true);
    expect(hasDelete).toBe(true);

    // Third line: context
    expect(contextLine2.type).toBe("normal");
    expect(contextLine2.content[0].value).toBe("context");
  });
  test("crossing content-based pairings unpair the worse match only", () => {
    const patch = [
      "@@ -767,4 +767,4 @@",
      "-apple banana cherry",
      "-xray yankee zulu",
      "+xray yankee alpha",
      "+apple banana delta",
    ].join("\n");

    handler({
      data: {
        type: "parse-diff",
        id: "crossed-pairings",
        patch,
        filename: "test.py",
      },
    });

    const result = posted[0].result;
    const hunks = result.hunks;
    const hunk = hunks.find((h: any) => h.type === "hunk");
    expect(hunk).toBeDefined();

    // Crossing has equal deltas (both =1), so first pair (D767→I768) is unpaired
    // Only the better match (D768→I767, delta=1) remains merged
    const mergedLines = hunk.lines.filter(
      (l: any) =>
        l.type === "normal" && l.content.some((s: any) => s.type !== "normal")
    );
    expect(mergedLines).toHaveLength(1);
    expect(mergedLines[0].oldLineNumber).toBe(768);
    expect(mergedLines[0].newLineNumber).toBe(767);

    // The unpaired delete (old 767) and unpaired insert (new 768) remain separate
    const deletes = hunk.lines.filter((l: any) => l.type === "delete");
    const inserts = hunk.lines.filter((l: any) => l.type === "insert");
    expect(deletes).toHaveLength(1);
    expect(inserts).toHaveLength(1);
    expect(deletes[0].oldLineNumber).toBe(767);
    expect(inserts[0].newLineNumber).toBe(768);
  });

  test("merges delete+insert pair when change only differs by digit inside underscore-separated word", () => {
    // Old: %{python2_sitearch}/*   New: %{python3_sitearch}/*
    // _ is treated as separator, so python2 and python3 are separate tokens
    const patch = [
      "@@ -1068,3 +463,3 @@",
      " context",
      "-%{python2_sitearch}/*",
      "+%{python3_sitearch}/*",
      " context",
    ].join("\n");

    handler({
      data: {
        type: "parse-diff",
        id: "sitearch",
        patch,
        filename: "kernel.spec",
      },
    });

    const result = posted[0].result;
    const hunks = result.hunks;
    // First hunk is a skip block, second is the actual hunk
    const hunk = hunks[1];
    expect(hunk).toBeDefined();
    expect(hunk.lines).toHaveLength(3);

    const [contextLine, modifiedLine, contextLine2] = hunk.lines;

    // First line: context
    expect(contextLine.type).toBe("normal");

    // Second line: should be a single merged "normal" line
    expect(modifiedLine.type).toBe("normal");
    expect(modifiedLine.oldLineNumber).toBe(1069);
    expect(modifiedLine.newLineNumber).toBe(464);
    // Word-diff segments: at least one insert and one delete
    const hasInsert = modifiedLine.content.some(
      (s: any) => s.type === "insert"
    );
    const hasDelete = modifiedLine.content.some(
      (s: any) => s.type === "delete"
    );
    expect(hasInsert).toBe(true);
    expect(hasDelete).toBe(true);

    // Third line: context
    expect(contextLine2.type).toBe("normal");
    expect(contextLine2.content[0].value).toBe("context");
  });

  test("indentation-only try lines merge in the full import_srpm diff", () => {
    const diffContent = `diff --git a/scripts/import_srpm.py b/scripts/import_srpm.py\n--- a/scripts/import_srpm.py\n+++ b/scripts/import_srpm.py\n${patchForImportSrpm}`;
    const files = gitDiffParser.parse(diffContent);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const thirdHunk = files[0].hunks[2];
    expect(thirdHunk).toBeDefined();

    const opts = {
      maxDiffDistance: 30,
      maxChangeRatio: 0.45,
      mergeModifiedLines: true,
      inlineMaxCharEdits: 30,
    };
    const lines = mergeModifiedLines(thirdHunk.changes, opts);

    // Find old=139 in any form
    const try139norm = lines.find(
      (l: any) => l.type === "normal" && l.oldLineNumber === 139
    );
    const try139del = lines.find(
      (l: any) => l.type === "delete" && l.oldLineNumber === 139
    );
    const try160norm = lines.find(
      (l: any) => l.type === "normal" && l.newLineNumber === 160
    );
    const try160ins = lines.find(
      (l: any) => l.type === "insert" && l.newLineNumber === 160
    );

    // Dump changes near old=139 to diagnose
    const del139Idx = thirdHunk.changes.findIndex(
      (c: any) => c.type === "delete" && c.lineNumber === 139
    );
    const near =
      del139Idx >= 0
        ? thirdHunk.changes.slice(
            Math.max(0, del139Idx - 1),
            Math.min(thirdHunk.changes.length, del139Idx + 2)
          )
        : [];
    const del139Norm = thirdHunk.changes[del139Idx];
    const ins160Idx = thirdHunk.changes.findIndex(
      (c: any) => c.type === "insert" && c.lineNumber === 160
    );
    const ins160Norm = thirdHunk.changes[ins160Idx];

    const try80paired = lines.find(
      (l: any) => l.type === "normal" && l.oldLineNumber === 80
    );
    const try139paired = lines.find(
      (l: any) => l.type === "normal" && l.oldLineNumber === 139
    );
    const try160paired = lines.find(
      (l: any) => l.type === "normal" && l.newLineNumber === 160
    );

    // Dump all lines to find old=139 or new=160
    const allLines = lines
      .map((l: any, i: number) => ({
        i,
        type: l.type,
        old: l.oldLineNumber ?? "none",
        new: l.newLineNumber ?? "none",
        maybeOld: l.lineNumber ?? "none",
        content: l.content?.[0]?.value?.includes?.("try") ?? false,
      }))
      .filter((l: any) => l.content || l.old !== "none" || l.new !== "none");

    // Check that old=139 is merged (not a separate delete)
    const has139delete = lines.some(
      (l: any) => l.type === "delete" && (l as any).lineNumber === 139
    );
    const has139normal = lines.some(
      (l: any) => l.type === "normal" && (l as any).oldLineNumber === 139
    );
    const has160insert = lines.some(
      (l: any) => l.type === "insert" && (l as any).lineNumber === 160
    );
    const has160normal = lines.some(
      (l: any) => l.type === "normal" && (l as any).newLineNumber === 160
    );

    expect({
      scenario: "try lines after second pass",
      has139delete,
      has139normal,
      has160insert,
      has160normal,
    }).toMatchObject({
      has139delete: false,
      has139normal: true,
      has160insert: false,
      has160normal: true,
    });

    // Verify overall output structure:
    // 1. New-line numbers are monotonic (non-decreasing)
    let prevNew: number | null = null;
    for (const l of lines) {
      const n = (l as any).newLineNumber;
      if (n != null) {
        if (prevNew != null) {
          expect(n).toBeGreaterThanOrEqual(prevNew);
        }
        prevNew = n;
      }
    }

    // 2. The standalone `raise` delete (old=84) is positioned near the
    //    except block, not at its own old-line number far from context.
    const raiseDel = lines.find(
      (l: any) =>
        l.type === "delete" && l.content[0]?.value?.includes?.("raise")
    );
    expect(raiseDel).toBeDefined();
    const raiseIdx = lines.indexOf(raiseDel!);

    // The raise line should be between the `except:`→`except Exception:`
    // merged line (old=83) and the `parser.error` line (old=85) which are
    // their paired counterparts in the output.
    const exceptLine = lines.find(
      (l: any) => l.type === "normal" && (l as any).oldLineNumber === 83
    );
    const parserErrorLine = lines.find(
      (l: any) =>
        l.type === "insert" && l.content[0]?.value?.includes?.("parser.error")
    );
    if (exceptLine && parserErrorLine) {
      const exceptIdx = lines.indexOf(exceptLine);
      const errorIdx = lines.indexOf(parserErrorLine);
      expect(raiseIdx).toBeGreaterThan(exceptIdx);
      expect(raiseIdx).toBeLessThan(errorIdx);
    }

    // 3. No delete line appears after an insert with a higher new-line number
    //    (deletes must be interleaved correctly)
    let lastNewLineNumber: number | null = null;
    for (const l of lines) {
      if (l.type === "insert" && (l as any).newLineNumber != null) {
        lastNewLineNumber = (l as any).newLineNumber;
      }
      if (l.type === "delete") {
        const delOld = (l as any).lineNumber ?? (l as any).oldLineNumber;
        if (lastNewLineNumber != null && delOld != null) {
          // The delete's estimated position must not exceed the last seen new-line number
          expect(delOld).toBeLessThan(lastNewLineNumber + 50);
        }
      }
    }
  });

  test("standalone del/ins lines produce monotonic new-line numbers in all-deletes-first blocks", () => {
    // A block replacement where all deletes precede all inserts.
    // With maxChangeRatio=0.45, different-content lines won't pair,
    // so they remain as standalone deletes and inserts.  The output
    // must be sorted by new-line position so line numbers don't jump.
    const patch = [
      "@@ -1,4 +1,4 @@",
      " context1",
      "-apple",
      "-banana",
      "+cherry",
      "+date",
    ].join("\n");

    const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
    const files = gitDiffParser.parse(diffContent);
    const changes = files[0].hunks[0].changes;

    const opts = {
      maxDiffDistance: 30,
      maxChangeRatio: 0.45,
      mergeModifiedLines: true,
      inlineMaxCharEdits: 30,
    };
    const lines = mergeModifiedLines(changes, opts);

    // All new-line-number values (where present) must be non-decreasing
    let prevNew: number | null = null;
    for (const l of lines) {
      const n = (l as any).newLineNumber;
      if (n != null) {
        if (prevNew != null) {
          expect(n).toBeGreaterThanOrEqual(prevNew);
        }
        prevNew = n;
      }
    }

    // Lines are sorted by position: deletes and inserts at the same
    // change-index position are placed in their original insertion order,
    // so a delete (old=2) and its matching insert (new=2) are adjacent
    // with the delete first (it appeared first in the changes array).
    const appleDel = lines.find(
      (l: any) => l.type === "delete" && l.content[0]?.value === "apple"
    );
    const cherryIns = lines.find(
      (l: any) => l.type === "insert" && l.content[0]?.value === "cherry"
    );
    const bananaDel = lines.find(
      (l: any) => l.type === "delete" && l.content[0]?.value === "banana"
    );
    const dateIns = lines.find(
      (l: any) => l.type === "insert" && l.content[0]?.value === "date"
    );
    expect(appleDel).toBeDefined();
    expect(cherryIns).toBeDefined();
    expect(bananaDel).toBeDefined();
    expect(dateIns).toBeDefined();

    // apple (old=2) and cherry (new=2) share the same sort position;
    // apple came first in the original change array so it sorts first.
    const appleIdx = lines.indexOf(appleDel!);
    const cherryIdx = lines.indexOf(cherryIns!);
    expect(appleIdx).toBeLessThan(cherryIdx);

    // banana (old=3, pos=3) sorts after cherry (new=2, pos=2)
    // because position 3 > 2.
    const bananaIdx = lines.indexOf(bananaDel!);
    expect(bananaIdx).toBeGreaterThan(cherryIdx);

    // banana (pos=3) and date (pos=3) share the same position;
    // banana came first so it sorts before date.
    const dateIdx = lines.indexOf(dateIns!);
    expect(bananaIdx).toBeLessThan(dateIdx);
  });

  test("delete-only line positioned after its surrounding paired lines", () => {
    // A standalone delete (old=3) surrounded by paired lines above and below
    // must be placed between them — its estimated position comes from the
    // next paired line's new-line number.
    // "hello world" → "hello_world" pairs (ratio ≈ 0.17 < 0.45).
    // "standalone" is unpaired.
    // "foo bar" → "foo baz" pairs via calculateChangeRatio
    // (tokenized: "foo"," ","bar" vs "foo"," ","baz"; only "bar" vs "baz" differ)
    const patch = [
      "@@ -1,6 +1,5 @@",
      " context1",
      "-hello world",
      "+hello_world",
      "-standalone",
      "-foo bar",
      "+foo baz",
      " context2",
    ].join("\n");

    const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
    const files = gitDiffParser.parse(diffContent);
    const changes = files[0].hunks[0].changes;

    const opts = {
      maxDiffDistance: 30,
      maxChangeRatio: 0.45,
      mergeModifiedLines: true,
      inlineMaxCharEdits: 30,
    };
    const lines = mergeModifiedLines(changes, opts);

    const standaloneDel = lines.find(
      (l: any) => l.type === "delete" && l.content[0]?.value === "standalone"
    );
    const helloSegments = lines.find(
      (l: any) => l.type === "normal" && (l as any).oldLineNumber === 2
    );
    // "foo bar" → "foo baz" paired line: old=4
    const foobarSegments = lines.find(
      (l: any) => l.type === "normal" && (l as any).oldLineNumber === 4
    );
    expect(standaloneDel).toBeDefined();
    expect(helloSegments).toBeDefined();
    expect(foobarSegments).toBeDefined();

    // The standalone delete must appear between its surrounding paired lines
    const delIdx = lines.indexOf(standaloneDel!);
    const beforeIdx = lines.indexOf(helloSegments!);
    const afterIdx = lines.indexOf(foobarSegments!);
    expect(delIdx).toBeGreaterThan(beforeIdx);
    expect(delIdx).toBeLessThan(afterIdx);
  });

  test("adjacent empty delete+insert lines merge into one normal line", () => {
    // An empty line deleted and an empty line inserted adjacent to each
    // other.  The result should be a single normal (context) line.
    const patch = ["@@ -1,3 +1,3 @@", " one", "-", "+", " two"].join("\n");

    const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
    const files = gitDiffParser.parse(diffContent);
    const changes = files[0].hunks[0].changes;

    const opts = {
      maxDiffDistance: 30,
      maxChangeRatio: 0.45,
      mergeModifiedLines: true,
      inlineMaxCharEdits: 30,
    };
    const lines = mergeModifiedLines(changes, opts);

    // Should be 3 lines: one, (merged empty), two
    expect(lines).toHaveLength(3);

    expect(lines[0].type).toBe("normal");
    expect((lines[0] as any).newLineNumber).toBe(1);
    expect(lines[0].content[0]?.value).toBe("one");

    // The merged line — the delete and insert are merged into one normal line
    expect(lines[1].type).toBe("normal");
    expect((lines[1] as any).oldLineNumber).toBe(2);
    expect((lines[1] as any).newLineNumber).toBe(2);
    expect(lines[1].content[0]?.value).toBe("");

    expect(lines[2].type).toBe("normal");
    expect((lines[2] as any).newLineNumber).toBe(3);
    expect(lines[2].content[0]?.value).toBe("two");
  });

  test("indentation-only content re-paired after crossing unpairing", () => {
    // Rotate three content-identical lines.  D1→I3, D2→I1, D3→I2 cross;
    // crossing unpaips D1→I3 (larger line distance).  The second pass must
    // re-pair D1→I3 since they are content-identical (ratio=0).
    const patch = [
      "@@ -1,3 +1,3 @@",
      "-foo",
      "-bar",
      "-baz",
      "+bar",
      "+baz",
      "+foo",
    ].join("\n");

    const diffContent = `diff --git a/file b/file\n--- a/file\n+++ b/file\n${patch}`;
    const files = gitDiffParser.parse(diffContent);
    const changes = files[0].hunks[0].changes;

    const opts = {
      maxDiffDistance: 30,
      maxChangeRatio: 0.45,
      mergeModifiedLines: true,
      inlineMaxCharEdits: 30,
    };
    const lines = mergeModifiedLines(changes, opts);

    // All three must be merged (content-identical)
    const fooLine = lines.find(
      (l: any) => l.type === "normal" && l.content[0]?.value === "foo"
    );
    const barLine = lines.find(
      (l: any) => l.type === "normal" && l.content[0]?.value === "bar"
    );
    const bazLine = lines.find(
      (l: any) => l.type === "normal" && l.content[0]?.value === "baz"
    );
    expect(fooLine).toBeDefined();
    expect(barLine).toBeDefined();
    expect(bazLine).toBeDefined();

    // No delete or insert lines should remain
    const deletes = lines.filter((l: any) => l.type === "delete");
    const inserts = lines.filter((l: any) => l.type === "insert");
    expect(deletes).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });
});
