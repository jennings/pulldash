import { test, expect } from "bun:test";
import {
  parseCommitMetadataMarker,
  isMetadataComment,
  getCommentDisplayPath,
  stripCommitMetadataPrefix,
  parseChangeIdFromPayload,
  COMMIT_METADATA_MARKER,
} from "./commit-metadata";

// ============================================================================
// parseCommitMetadataMarker
// ============================================================================

test("parseCommitMetadataMarker extracts sha, line, and label", () => {
  const body =
    "<!-- pulldash:commit-metadata sha=abc1234 line=5 label=Author -->";
  const result = parseCommitMetadataMarker(body);
  expect(result).toEqual({ sha: "abc1234", line: 5, label: "Author" });
});

test("parseCommitMetadataMarker extracts label with spaces", () => {
  const body =
    "<!-- pulldash:commit-metadata sha=abc1234 line=5 label=Commit message -->";
  const result = parseCommitMetadataMarker(body);
  expect(result).toEqual({
    sha: "abc1234",
    line: 5,
    label: "Commit message",
  });
});

test("parseCommitMetadataMarker extracts full 40-char SHA", () => {
  const sha = "de02b9a98e3f8eed85d6738928880424e06d7767";
  const body = `<!-- pulldash:commit-metadata sha=${sha} line=1 label=Author -->`;
  const result = parseCommitMetadataMarker(body);
  expect(result).toEqual({ sha, line: 1, label: "Author" });
});

test("parseCommitMetadataMarker returns null for body without marker", () => {
  expect(parseCommitMetadataMarker("normal comment body")).toBeNull();
});

test("parseCommitMetadataMarker returns null for empty string", () => {
  expect(parseCommitMetadataMarker("")).toBeNull();
});

test("parseCommitMetadataMarker returns null for marker with missing fields", () => {
  const body = "<!-- pulldash:commit-metadata sha=abc1234 -->";
  expect(parseCommitMetadataMarker(body)).toBeNull();
});

test("parseCommitMetadataMarker ignores text before marker", () => {
  const body =
    "prefix text\n<!-- pulldash:commit-metadata sha=abc line=1 label=Test -->\nsuffix text";
  const result = parseCommitMetadataMarker(body);
  expect(result).toEqual({ sha: "abc", line: 1, label: "Test" });
});

test("parseCommitMetadataMarker parses line number as integer", () => {
  const body =
    "<!-- pulldash:commit-metadata sha=abc line=42 label=Committer -->";
  const result = parseCommitMetadataMarker(body);
  expect(result?.line).toBe(42);
});

// ============================================================================
// isMetadataComment
// ============================================================================

test("isMetadataComment returns true for body containing marker", () => {
  const body = "<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->";
  expect(isMetadataComment(body)).toBe(true);
});

test("isMetadataComment returns false for regular comment body", () => {
  expect(isMetadataComment("this is a normal comment")).toBe(false);
});

test("isMetadataComment returns false for empty string", () => {
  expect(isMetadataComment("")).toBe(false);
});

test("isMetadataComment returns false for null", () => {
  expect(isMetadataComment(null)).toBe(false);
});

test("isMetadataComment returns false for undefined", () => {
  expect(isMetadataComment(undefined)).toBe(false);
});

test("isMetadataComment returns true for body with prefix text before marker", () => {
  const body =
    "This comment was made on the commit metadata for commit abc, on the Author line.\n\n<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->\n\nactual review text";
  expect(isMetadataComment(body)).toBe(true);
});

// ============================================================================
// getCommentDisplayPath
// ============================================================================

test("getCommentDisplayPath returns Commit metadata for metadata comment", () => {
  const comment = {
    path: ":commit",
    body: "<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->",
  };
  expect(getCommentDisplayPath(comment)).toBe("Commit metadata");
});

test("getCommentDisplayPath returns the path for regular comment", () => {
  const comment = {
    path: "src/file.ts",
    body: "this is a normal comment",
  };
  expect(getCommentDisplayPath(comment)).toBe("src/file.ts");
});

test("getCommentDisplayPath returns the path when body is null", () => {
  const comment = { path: "src/file.ts", body: null };
  expect(getCommentDisplayPath(comment)).toBe("src/file.ts");
});

test("getCommentDisplayPath returns the path when body is undefined", () => {
  const comment = { path: "src/file.ts" };
  expect(getCommentDisplayPath(comment)).toBe("src/file.ts");
});

test("getCommentDisplayPath returns Commit metadata for pending comment with marker", () => {
  const comment = {
    path: ":commit",
    body: "<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->",
  };
  expect(getCommentDisplayPath(comment)).toBe("Commit metadata");
});

// ============================================================================
// stripCommitMetadataPrefix
// ============================================================================

test("stripCommitMetadataPrefix removes marker from body", () => {
  const body =
    "prefix\n<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->\n\nactual text";
  expect(stripCommitMetadataPrefix(body)).toBe("actual text");
});

test("stripCommitMetadataPrefix removes marker with prefix comment text", () => {
  const body =
    "_This comment was made on the commit metadata for commit abc, on the Author line._\n\n<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->\n\nactual review text";
  expect(stripCommitMetadataPrefix(body)).toBe("actual review text");
});

test("stripCommitMetadataPrefix returns body unchanged if no marker", () => {
  const body = "normal comment text";
  expect(stripCommitMetadataPrefix(body)).toBe("normal comment text");
});

test("stripCommitMetadataPrefix handles marker at end of body", () => {
  const body =
    "text before\n<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->";
  expect(stripCommitMetadataPrefix(body)).toBe("");
});

test("stripCommitMetadataPrefix handles empty body", () => {
  expect(stripCommitMetadataPrefix("")).toBe("");
});

test("stripCommitMetadataPrefix handles body with only marker", () => {
  const body = "<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->";
  expect(stripCommitMetadataPrefix(body)).toBe("");
});

test("stripCommitMetadataPrefix preserves content after marker with leading whitespace", () => {
  const body =
    "<!-- pulldash:commit-metadata sha=abc line=1 label=Author -->\n  \nindented text";
  expect(stripCommitMetadataPrefix(body)).toBe("indented text");
});

test("stripCommitMetadataPrefix ignores body with unclosed marker comment", () => {
  const body = "<!-- pulldash:commit-metadata sha=abc line=1 label=Author";
  expect(stripCommitMetadataPrefix(body)).toBe(body);
});

// ============================================================================
// parseChangeIdFromPayload
// ============================================================================

test("parseChangeIdFromPayload extracts jj change-id from raw payload", () => {
  const payload =
    "tree abc\nparent def\nauthor Name <email> 1234 +0000\ncommitter Name <email> 5678 +0000\nchange-id lqumvuttsztkotykvwzrswsvnsukztsy\ngpgsig -----BEGIN SSH SIGNATURE-----\n line\n -----END SSH SIGNATURE-----\n\ncommit subject\n\ncommit body";
  expect(parseChangeIdFromPayload(payload)).toBe(
    "lqumvuttsztkotykvwzrswsvnsukztsy"
  );
});

test("parseChangeIdFromPayload extracts Gerrit Change-Id from raw payload", () => {
  const payload =
    "tree abc\nparent def\nauthor Name <email> 1234 +0000\ncommitter Name <email> 5678 +0000\nChange-Id: Iabcd1234efgh5678abcdef1234abcdef5678\n\ncommit subject\n\ncommit body";
  expect(parseChangeIdFromPayload(payload)).toBe(
    "Iabcd1234efgh5678abcdef1234abcdef5678"
  );
});

test("parseChangeIdFromPayload returns null when no change-id header", () => {
  const payload =
    "tree abc\nparent def\nauthor Name <email> 1234 +0000\ncommitter Name <email> 5678 +0000\n\ncommit subject\n\ncommit body";
  expect(parseChangeIdFromPayload(payload)).toBeNull();
});

test("parseChangeIdFromPayload returns null for payload with only message body", () => {
  const payload = "commit subject\n\ncommit body";
  expect(parseChangeIdFromPayload(payload)).toBeNull();
});

test("parseChangeIdFromPayload returns null for empty payload", () => {
  expect(parseChangeIdFromPayload("")).toBeNull();
});
