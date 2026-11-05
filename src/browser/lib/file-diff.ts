import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestFile } from "../../api/types";

/** Where each side of a (comparison) diff can be fetched from. */
export interface DiffSources {
  old: { sha: string; path: string; exists?: boolean };
  new: { sha: string; path: string; exists?: boolean };
}

/** A file's diff as the app holds it: Pierre's model plus app-level state. */
export interface LoadedDiff {
  fileDiff: FileDiffMetadata;
  error?: string;
  sources?: DiffSources;
  /** Indexes into `fileDiff.hunks` that only exist because of a rebase. */
  rebaseArtifactHunks?: readonly number[];
}

export interface PatchInput {
  /** Hunk-only patch (starts at `@@`), as in `PullRequestFile.patch`. */
  patch: string;
  filename: string;
  previousFilename?: string;
  /** `PullRequestFile["status"]`; decides new/deleted/rename headers. */
  status?: PullRequestFile["status"];
  /** Key for Pierre's worker-pool render cache. Must change with the content. */
  cacheKey?: string;
}

function syntheticHeader({
  patch,
  filename,
  previousFilename,
  status,
}: Pick<PatchInput, "patch" | "filename" | "previousFilename" | "status">) {
  // A copy leaves the source in place, so it is not a rename. Pierre has no
  // copy type (it keeps `prevName` only for renames), so a copy is presented as
  // an ordinary change to the new path.
  const renamed =
    status !== "copied" &&
    (status === "renamed" ||
      (previousFilename !== undefined && previousFilename !== filename));
  const oldName = renamed ? (previousFilename ?? filename) : filename;
  const lines = [`diff --git a/${oldName} b/${filename}`];
  if (status === "added") {
    lines.push("new file mode 100644", "--- /dev/null", `+++ b/${filename}`);
  } else if (status === "removed") {
    lines.push("deleted file mode 100644", `--- a/${oldName}`, "+++ /dev/null");
  } else if (renamed) {
    // Pierre only reads the rename from "similarity index"/"rename" lines, and
    // only calls it a pure rename at 100%. Git omits ---/+++ for those.
    const pure = patch.trim() === "";
    lines.push(
      `similarity index ${pure ? 100 : 50}%`,
      `rename from ${oldName}`,
      `rename to ${filename}`
    );
    if (!pure) lines.push(`--- a/${oldName}`, `+++ b/${filename}`);
  } else {
    lines.push(`--- a/${oldName}`, `+++ b/${filename}`);
  }
  return lines.join("\n");
}

/**
 * Build Pierre's diff model from a hunk-only patch (GitHub's
 * `PullRequestFile.patch` and review-comment `diff_hunk` carry no file header)
 * by synthesizing the header Pierre's parser expects. An empty or unparseable
 * patch yields a diff with no hunks rather than throwing.
 */
export function fileDiffFromPatch(input: PatchInput): FileDiffMetadata {
  const header = syntheticHeader(input);
  const body = input.patch.trim() === "" ? "" : `${input.patch}\n`;
  const parse = (text: string) => {
    try {
      return parsePatchFiles(text)[0]?.files[0];
    } catch {
      return undefined;
    }
  };
  // Header alone parses to a hunk-less file with the right name/type, which is
  // also the fallback for a patch Pierre cannot make sense of.
  const fileDiff = parse(`${header}\n${body}`) ?? parse(`${header}\n`);
  if (!fileDiff) {
    throw new Error(`Failed to build a diff model for ${input.filename}`);
  }
  if (input.cacheKey !== undefined) fileDiff.cacheKey = input.cacheKey;
  return fileDiff;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Narrow a single-hunk patch to the lines around a review comment: from
 * `contextLines` before the start of the commented range through its last
 * line. A line is matched by its new-file number (additions, context) or its
 * old-file number (deletions). The kept lines are made contiguous.
 *
 * The hunk header is always rewritten from the kept lines, because GitHub's
 * review-comment `diff_hunk` is cut off at the commented line while its header
 * still declares the full hunk's counts. Without a line, or when nothing falls
 * in the window, the whole hunk is kept. A patch with no parseable hunk header
 * is returned unchanged.
 */
export function windowPatchAroundLines(
  patch: string,
  range: { line: number | null; startLine?: number | null },
  contextLines = 4
): string {
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const headerAt = rows.findIndex((row) => row.startsWith("@@"));
  const header = headerAt >= 0 ? HUNK_HEADER.exec(rows[headerAt]!) : null;
  if (!header) return patch;

  const { line } = range;
  const rangeStart = line ? (range.startLine ?? line) - contextLines : 0;
  const rangeEnd = line ?? 0;

  interface Row {
    text: string;
    oldNo: number | null;
    newNo: number | null;
  }
  const body: Row[] = [];
  let oldNo = Number(header[1]);
  let newNo = Number(header[3]);
  for (const text of rows.slice(headerAt + 1)) {
    if (text.startsWith("@@")) break;
    const marker = text[0];
    if (marker === "\\") {
      body.push({ text, oldNo: null, newNo: null });
    } else if (marker === "+") {
      body.push({ text, oldNo: null, newNo: newNo++ });
    } else if (marker === "-") {
      body.push({ text, oldNo: oldNo++, newNo: null });
    } else {
      body.push({ text, oldNo: oldNo++, newNo: newNo++ });
    }
  }

  const inWindow = (row: Row) => {
    const lineNo = row.newNo ?? row.oldNo;
    return lineNo !== null && lineNo >= rangeStart && lineNo <= rangeEnd;
  };
  const found = line ? body.findIndex(inWindow) : -1;
  const firstIndex = Math.max(found, 0);
  let end = found < 0 ? body.length - 1 : body.findLastIndex(inWindow);
  // A "\ No newline at end of file" marker belongs to the line before it.
  while (body[end + 1]?.text.startsWith("\\")) end++;
  const kept = body.slice(firstIndex, end + 1);

  // Git numbers an empty side by the line before it.
  const startOf = (side: "oldNo" | "newNo", next: number) => {
    const first = kept.find((r) => r[side] !== null)?.[side];
    if (first != null) return first;
    const after = body.slice(firstIndex).find((r) => r[side] !== null)?.[side];
    return (after ?? next) - 1;
  };
  const oldCount = kept.filter((r) => r.oldNo !== null).length;
  const newCount = kept.filter((r) => r.newNo !== null).length;
  return [
    `@@ -${startOf("oldNo", oldNo)},${oldCount} +${startOf("newNo", newNo)},${newCount} @@${header[5]}`,
    ...kept.map((r) => r.text),
  ].join("\n");
}
