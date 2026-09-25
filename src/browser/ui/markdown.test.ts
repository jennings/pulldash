import { test, expect } from "bun:test";
import {
  extractIssueLinkRefs,
  highlightToHtml,
  isPositionInCodeFence,
  shortenCommitUrl,
  buildMentionSuggestions,
  type MentionUser,
  type MentionTeam,
} from "./markdown";

test("extracts refs from relative PR hrefs", () => {
  const html = `<a class="issue-link js-issue-link" data-id="1" href="/xcp-ng/xcp/pull/838">#838</a>`;
  expect(extractIssueLinkRefs(html)).toEqual([
    { owner: "xcp-ng", repo: "xcp", number: 838 },
  ]);
});

test("extracts refs from absolute hrefs and issues, deduped", () => {
  const html = [
    `<a class="issue-link" href="https://github.com/o/r/pull/1">#1</a>`,
    `<a class="issue-link" href="/o/r/pull/1">#1</a>`,
    `<a class="issue-link" href="/o/r/issues/2">#2</a>`,
  ].join("\n");
  expect(extractIssueLinkRefs(html)).toEqual([
    { owner: "o", repo: "r", number: 1 },
    { owner: "o", repo: "r", number: 2 },
  ]);
});

test("ignores anchors without the issue-link class", () => {
  const html = `<a href="/o/r/pull/1">docs</a><a class="other" href="/o/r/pull/2">#2</a>`;
  expect(extractIssueLinkRefs(html)).toEqual([]);
});

test("returns empty for html without issue links", () => {
  expect(extractIssueLinkRefs("<p>nothing here</p>")).toEqual([]);
});

test("shortens commit urls to owner/repo@sha7", () => {
  expect(
    shortenCommitUrl(
      "https://github.com/systemd/systemd/commit/c5ba7a2a4dd19a2d31b8a9d52d3c4bdde78387f0"
    )
  ).toBe("systemd/systemd@c5ba7a2");
});

test("shortens commit urls with trailing slash or query", () => {
  expect(shortenCommitUrl("https://github.com/o/r/commit/77d8f1526/")).toBe(
    "o/r@77d8f15"
  );
  expect(
    shortenCommitUrl(
      "https://github.com/o/r/commit/77d8f1526?diff=split#comments"
    )
  ).toBe("o/r@77d8f15");
});

test("returns null for non-commit urls", () => {
  expect(shortenCommitUrl("https://github.com/o/r/pull/1")).toBeNull();
  expect(shortenCommitUrl("https://github.com/o/r")).toBeNull();
  expect(shortenCommitUrl("/o/r/commit/77d8f15")).toBeNull();
});

const u = (login: string): MentionUser => ({ login, avatar_url: "" });
const team = (slug: string): MentionTeam => ({ slug });

test("mention suggestions rank participants, repo users, then teams", () => {
  const out = buildMentionSuggestions(
    "",
    [u("author"), u("reviewer")],
    [u("committer"), u("reviewer")],
    [team("ci"), team("release")]
  );
  expect(out.map((s) => s.login)).toEqual([
    "author",
    "reviewer",
    "committer",
    "ci",
    "release",
  ]);
  expect(out[3].team).toBe(true);
});

test("mention suggestions filter by query case-insensitively", () => {
  const out = buildMentionSuggestions(
    "LE",
    [u("glehmann"), u("semarie")],
    [u("bleader")],
    [team("release")]
  );
  expect(out.map((s) => s.login)).toEqual(["glehmann", "bleader", "release"]);
  expect(out[2].team).toBe(true);
});

test("mention suggestions fall back to avatar from login", () => {
  const out = buildMentionSuggestions("", [u("glehmann")], [], []);
  expect(out[0].avatar_url).toBe(
    "https://avatars.githubusercontent.com/glehmann"
  );
});

test("isPositionInCodeFence only turns on below the opening fence", () => {
  const value = ["before", "```js", "const x = 1;", "```", "after"].join("\n");
  expect(isPositionInCodeFence(value, 0)).toBe(false);
  // On the opening fence line itself
  expect(isPositionInCodeFence(value, value.indexOf("```js") + 5)).toBe(false);
  // First content line and after
  expect(isPositionInCodeFence(value, value.indexOf("const"))).toBe(true);
  // Start of the closing fence line is still inside the block
  expect(isPositionInCodeFence(value, value.lastIndexOf("```") + 1)).toBe(true);
  // After the closing fence
  expect(isPositionInCodeFence(value, value.indexOf("after"))).toBe(false);
});

test("isPositionInCodeFence supports tilde fences", () => {
  const value = ["~~~", "code", "~~~", "prose"].join("\n");
  expect(isPositionInCodeFence(value, value.indexOf("code"))).toBe(true);
  expect(isPositionInCodeFence(value, value.indexOf("prose"))).toBe(false);
});

test("isPositionInCodeFence treats an unclosed fence as code", () => {
  const value = ["```", "a", "b"].join("\n");
  expect(isPositionInCodeFence(value, 2)).toBe(false);
  expect(isPositionInCodeFence(value, value.indexOf("a"))).toBe(true);
  expect(isPositionInCodeFence(value, value.indexOf("b"))).toBe(true);
});

test("isPositionInCodeFence ignores non-matching closing fences", () => {
  const longer = ["````", "a", "```", "still code"].join("\n");
  expect(isPositionInCodeFence(longer, longer.indexOf("still"))).toBe(true);

  const differentChar = ["```", "a", "~~~", "still code"].join("\n");
  expect(
    isPositionInCodeFence(differentChar, differentChar.indexOf("still"))
  ).toBe(true);
});

test("isPositionInCodeFence ignores inline code", () => {
  const value = "some `code` here";
  expect(isPositionInCodeFence(value, value.indexOf("code"))).toBe(false);
  expect(isPositionInCodeFence(value, value.length + 5)).toBe(false);
});

test("highlightToHtml emits Prism token spans", () => {
  const html = highlightToHtml("const x = 1;", "js");
  expect(html).not.toBeNull();
  expect(html).toContain('class="token keyword"');
  expect(html).toContain('class="token number"');
});

test("highlightToHtml returns null for unknown languages", () => {
  expect(highlightToHtml("const x = 1;", "notalang")).toBeNull();
});
