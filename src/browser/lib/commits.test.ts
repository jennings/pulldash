import { test, expect } from "bun:test";
import {
  parseCoAuthors,
  loginFromCommitEmail,
  formatCoAuthorNames,
  commitParties,
} from "./commits";

// xcp-ng-build-env 2fd63361. The author also signs off on his own commit, so
// treating Signed-off-by as a co-author would list him twice.
const xcpNgMessage = `pass flag required with podman and selinux

--security-opt label=disable is more performant that using :Z at the end
of the mount option.

Signed-off-by: Gaëtan Lehmann <gaetan.lehmann@vates.tech>
Co-authored-by: Gael Duperrey <gduperrey@vates.tech>
Co-authored-by: Thierry Escande <thierry.escande@vates.tech>`;

test("reads co-authors from the trailer block", () => {
  expect(parseCoAuthors(xcpNgMessage)).toEqual([
    { name: "Gael Duperrey", email: "gduperrey@vates.tech" },
    { name: "Thierry Escande", email: "thierry.escande@vates.tech" },
  ]);
});

test("sign-off trailers are not co-authors", () => {
  const names = parseCoAuthors(xcpNgMessage).map((c) => c.name);
  expect(names).not.toContain("Gaëtan Lehmann");
});

test("co-authored-by mentioned in prose is not a trailer", () => {
  const message = `tweak the importer

This mirrors upstream, which sets Co-authored-by: Someone <someone@else.dev>
in its own patches.

Signed-off-by: A Dev <adev@example.org>`;
  expect(parseCoAuthors(message)).toEqual([]);
});

test("trailer keys are matched case-insensitively", () => {
  expect(
    parseCoAuthors("fix\n\nco-authored-by: Jane Doe <jane@example.org>")
  ).toEqual([{ name: "Jane Doe", email: "jane@example.org" }]);
});

test("identities without an email still count", () => {
  expect(parseCoAuthors("fix\n\nCo-authored-by: Jane Doe")).toEqual([
    { name: "Jane Doe", email: "" },
  ]);
});

test("repeated trailers collapse", () => {
  const message = `fix

Co-authored-by: Jane Doe <jane@example.org>
Co-authored-by: JANE DOE <Jane@Example.org>
Co-authored-by: Jane <jane@example.org>`;
  expect(parseCoAuthors(message).map((c) => c.name)).toEqual(["Jane Doe"]);
});

// A Weblate import commit credits one person per translation, listing the same
// person twice when they contributed under two addresses.
test("the same name under a different email collapses", () => {
  const message = `Import translations from Weblate

Co-authored-by: Oğuz Ersen <oguz@ersen.moe>
Co-authored-by: Oğuz Ersen <oguzersen@protonmail.com>
Co-authored-by: Jane Doe <jane@example.org>`;
  expect(parseCoAuthors(message).map((c) => c.name)).toEqual([
    "Oğuz Ersen",
    "Jane Doe",
  ]);
});

// Truncated from a real calyxos Weblate commit: the co-author block is followed
// by two more trailers, then Change-Id in its own paragraph.
test("a trailer block split by Change-Id is still one block", () => {
  const message = `Import translations from Weblate

Co-authored-by: Jane Doe <jane@example.org>
Translate-URL: https://hosted.weblate.org/projects/p/
Translation: CalyxOS/Launcher

Change-Id: I9d52f7eeb467b57c18bcf678a5be6271ffc4f9e7`;
  expect(parseCoAuthors(message).map((c) => c.name)).toEqual(["Jane Doe"]);
});

test("messages without co-authors yield nothing", () => {
  expect(parseCoAuthors("")).toEqual([]);
  expect(parseCoAuthors("just a subject")).toEqual([]);
  expect(parseCoAuthors("subject\n\nbody only")).toEqual([]);
});

test("co-author trailers followed by prose are not a block", () => {
  const message = `fix

Co-authored-by: Not A Co-Author <fake@example.org>

And then a closing paragraph of prose.`;
  expect(parseCoAuthors(message)).toEqual([]);
});

test("noreply emails resolve to a login", () => {
  expect(
    loginFromCommitEmail("93733756+KalebCole@users.noreply.github.com")
  ).toBe("KalebCole");
  expect(loginFromCommitEmail("hartra344@users.noreply.github.com")).toBe(
    "hartra344"
  );
  expect(
    loginFromCommitEmail("198982749+Copilot@users.noreply.github.com")
  ).toBe("Copilot");
});

test("real email addresses do not resolve to a login", () => {
  expect(loginFromCommitEmail("gduperrey@vates.tech")).toBeUndefined();
  expect(loginFromCommitEmail("james.hong@zapier.com")).toBeUndefined();
  expect(loginFromCommitEmail("")).toBeUndefined();
  expect(
    loginFromCommitEmail("gduperrey@users.noreply.github.com.evil.dev")
  ).toBeUndefined();
});

test("co-authors from noreply commits carry a login", () => {
  expect(
    parseCoAuthors(
      "fix\n\nCo-authored-by: Kaleb Cole <93733756+KalebCole@users.noreply.github.com>"
    )
  ).toEqual([
    {
      name: "Kaleb Cole",
      email: "93733756+KalebCole@users.noreply.github.com",
      login: "KalebCole",
    },
  ]);
});

test("co-author names read as a list", () => {
  const names = (n: number) =>
    formatCoAuthorNames(
      Array.from({ length: n }, (_, i) => ({
        name: ["Jane", "John", "Jill", "Jack"][i],
        email: "",
      }))
    );
  expect(names(0)).toBe("");
  expect(names(1)).toBe("Jane");
  expect(names(2)).toBe("Jane and John");
  expect(names(3)).toBe("Jane, John and Jill");
});

test("long co-author lists collapse past the cap", () => {
  const many = formatCoAuthorNames(
    Array.from({ length: 77 }, (_, i) => ({ name: `Person ${i}`, email: "" }))
  );
  expect(many).toBe("Person 0, Person 1 and 75 more");
  expect(
    formatCoAuthorNames(
      [
        { name: "Jane", email: "" },
        { name: "John", email: "" },
        { name: "Jill", email: "" },
        { name: "Jack", email: "" },
      ],
      2
    )
  ).toBe("Jane and 3 more");
});

// ============================================================================
// Author vs committer
// ============================================================================

function commit(over: Record<string, unknown> = {}) {
  return {
    author: { login: "ydirson", name: "Yann Dirson", avatar_url: "a.png" },
    committer: {
      login: "d3athjest3r",
      name: "Julian Vetter",
      avatar_url: "c.png",
    },
    commit: {
      author: { name: "Yann Dirson", email: "ydirson@vates.tech" },
      committer: { name: "Julian Vetter", email: "julian@vates.tech" },
    },
    ...over,
  };
}

test("a rebase credits the commit to two people", () => {
  const parties = commitParties(commit());
  expect(parties.sameParty).toBe(false);
  expect(parties.author.login).toBe("ydirson");
  expect(parties.committer.login).toBe("d3athjest3r");
  expect(parties.author.avatarUrl).toBe("a.png");
  expect(parties.committer.avatarUrl).toBe("c.png");
});

test("one person authoring and committing is a single identity", () => {
  const parties = commitParties(
    commit({
      committer: {
        login: "ydirson",
        name: "Yann Dirson",
        avatar_url: "a.png",
      },
      commit: {
        author: { name: "Yann Dirson", email: "ydirson@vates.tech" },
        committer: { name: "Yann Dirson", email: "ydirson@vates.tech" },
      },
    })
  );
  expect(parties.sameParty).toBe(true);
  expect(parties.committer.login).toBe("ydirson");
});

test("unlinked emails fall back to the git name", () => {
  const parties = commitParties(
    commit({
      author: null,
      commit: {
        author: { name: "Someone Local", email: "someone@localhost" },
        committer: { name: "Someone Local", email: "someone@localhost" },
      },
    })
  );
  expect(parties.author.name).toBe("Someone Local");
  expect(parties.author.login).toBeUndefined();
  expect(parties.author.avatarUrl).toBeUndefined();
  // Same address on both sides still means one person.
  expect(parties.sameParty).toBe(true);
});

test("identities with no account fall back to comparing emails", () => {
  const parties = commitParties(
    commit({
      author: null,
      committer: null,
      commit: {
        author: { name: "Alex", email: "alex@example.org" },
        committer: { name: "Alex Smith", email: "ALEX@example.org" },
      },
    })
  );
  expect(parties.sameParty).toBe(true);
});

test("web-flow rebases read as a second party", () => {
  const parties = commitParties(
    commit({
      committer: {
        login: "web-flow",
        name: "web-flow",
        avatar_url: "w.png",
      },
      commit: {
        author: { name: "Yann Dirson", email: "ydirson@vates.tech" },
        committer: { name: "GitHub", email: "noreply@github.com" },
      },
    })
  );
  expect(parties.sameParty).toBe(false);
  expect(parties.committer.name).toBe("GitHub");
});
