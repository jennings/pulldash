export interface CoAuthor {
  name: string;
  email: string;
  /** Only set when the trailer email is a GitHub noreply address. */
  login?: string;
}

/** One of the two identities git records for a commit. Either may be missing
 *  a linked GitHub account when the email is not one GitHub knows. */
export interface CommitParty {
  name: string;
  login?: string;
  avatarUrl?: string;
}

/** The parts of a REST commit this module reads. Structurally satisfied by
 *  `PRCommit`, so callers do not have to widen the octokit account unions. */
interface CommitLike {
  author?: { login?: string; name?: string | null; avatar_url?: string } | null;
  committer?: {
    login?: string;
    name?: string | null;
    avatar_url?: string;
  } | null;
  commit: {
    author?: { name?: string; email?: string } | null;
    committer?: { name?: string; email?: string } | null;
  };
}

export interface CommitParties {
  author: CommitParty;
  committer: CommitParty;
  /** False after a rebase or a cherry-pick, where a second person committed the
   *  code without writing it. */
  sameParty: boolean;
}

function party(
  account: CommitLike["author"],
  git: CommitLike["commit"]["author"]
): CommitParty {
  const login = account?.login || undefined;
  return {
    // The git name is what the commit actually claims; the account name and
    // login only stand in when the commit carries no usable name at all.
    name: git?.name?.trim() || account?.name?.trim() || login || "Someone",
    login,
    avatarUrl: account?.avatar_url,
  };
}

function sameParty(
  a: { login?: string; name: string },
  b: { login?: string; name: string },
  aEmail?: string,
  bEmail?: string
): boolean {
  if (a.login && b.login) return a.login === b.login;
  if (aEmail && bEmail) return aEmail.toLowerCase() === bEmail.toLowerCase();
  return a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * The author and committer of a commit. Usually the same person, but rebasing
 * or cherry-picking rewrites the committer, so on a long-lived PR branch most
 * commits are credited to someone other than their author — GitHub surfaces
 * both for that reason.
 */
export function commitParties(commit: CommitLike): CommitParties {
  const author = party(commit.author, commit.commit.author);
  const committer = party(commit.committer, commit.commit.committer);
  return {
    author,
    committer,
    sameParty: sameParty(
      author,
      committer,
      commit.commit.author?.email,
      commit.commit.committer?.email
    ),
  };
}

const TRAILER_KEY_RE = /^[A-Za-z][A-Za-z0-9-]*:/;
const CO_AUTHOR_RE = /^co-authored-by:[ \t]*(.+)$/i;

/**
 * The trailing run of `Token: value` lines, walked backwards from the end of
 * the message. Blank lines are traversed so a block that Gerrit-style messages
 * split off (Weblate's own commits end `... Translation: X\n\nChange-Id: Y`)
 * still reads as one block, while the walk stops at the first line that is not
 * trailer-shaped — so a `Co-authored-by:` quoted inside body prose is not a
 * trailer.
 */
function trailerLines(message: string): string[] {
  const lines = message.trimEnd().split("\n");
  const block: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (!TRAILER_KEY_RE.test(line)) break;
    block.unshift(line);
  }
  return block;
}

/** `Name <email>` — the email is optional because some tooling omits it. */
function splitIdentity(value: string): { name: string; email: string } {
  const match = value.match(/^(.*?)\s*<([^>]*)>[ \t]*$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: value.trim(), email: "" };
}

/**
 * Co-authors declared via `Co-authored-by:` trailers, in message order.
 *
 * GitHub's REST commit schema carries a single author account and no co-author
 * list, so trailers in `commit.message` are the only source. `Signed-off-by:`
 * is deliberately ignored: projects that require DCO sign off on their own
 * commits, which would list the author as their own co-author.
 *
 * Mass-import commits can carry dozens of co-authors (Weblate credits one
 * person per translation), so callers should cap what they render.
 */
export function parseCoAuthors(message: string): CoAuthor[] {
  const coAuthors: CoAuthor[] = [];
  // One person can be credited twice under different addresses, and the same
  // name twice reads as a bug in a list, so match on either.
  const seenEmails = new Set<string>();
  const seenNames = new Set<string>();

  for (const line of trailerLines(message)) {
    const match = CO_AUTHOR_RE.exec(line);
    if (!match) continue;

    const { name, email } = splitIdentity(match[1]);
    if (!name) continue;

    const emailKey = email.toLowerCase();
    const nameKey = name.toLowerCase();
    if (seenEmails.has(emailKey) || seenNames.has(nameKey)) continue;
    seenEmails.add(emailKey);
    seenNames.add(nameKey);

    const login = loginFromCommitEmail(email);
    coAuthors.push({ name, email, ...(login && { login }) });
  }

  return coAuthors;
}

const NOREPLY_RE =
  /^(?:[0-9]+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\.github\.com$/;

/**
 * GitHub login encoded in a commit email, for the noreply addresses GitHub
 * issues when a commit is made through its web UI. Commits made from a local
 * clone carry the user's real address, which GitHub does not let us resolve to
 * an account without a search call — those stay name-only.
 *
 * The local part after `+` is user-configurable and may not be the login, so
 * callers must treat a returned login as a guess and fall back to the name when
 * the account does not resolve.
 */
export function loginFromCommitEmail(email: string): string | undefined {
  const match = NOREPLY_RE.exec(email.trim());
  return match?.[1];
}

/**
 * "Jane", "Jane and John", "Jane, John and Jill", collapsing to
 * "Jane, John and 74 more" past `max`.
 */
export function formatCoAuthorNames(coAuthors: CoAuthor[], max = 3): string {
  const names = coAuthors.map((c) => c.name);
  if (names.length === 0) return "";
  if (names.length > max) {
    return `${names.slice(0, max - 1).join(", ")} and ${names.length - max + 1} more`;
  }
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
