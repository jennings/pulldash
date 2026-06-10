// Maximum number of character-level edits for inline diff highlighting.
// Lower values reduce noise on large line rewrites (where character diffs
// are misleading); higher values show more granularity on small tweaks.
// 4 is conservative: highlights only compact, clearly intentional edits.
export const INLINE_MAX_CHAR_EDITS = 4;
