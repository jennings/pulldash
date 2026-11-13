// Pulldash's diff colors on top of Pierre's theme, for its `unsafeCSS` option:
// rows tinted the same under the line numbers as under the code, gray line
// numbers, and a solid gutter bar, green for additions and orange for
// deletions. Hover and selection colors derive from the row background.

const ADDED = "34 197 94";
const REMOVED = "234 88 12";

export const DIFF_COLORS_CSS = `
:host {
  --diffs-fg-number-addition-override: var(--diffs-fg-number);
  --diffs-fg-number-deletion-override: var(--diffs-fg-number);
  --diffs-bg-addition-emphasis-override: rgb(${ADDED} / 0.2);
  --diffs-bg-deletion-emphasis-override: rgb(${REMOVED} / 0.2);
}
[data-line-type="change-addition"]:where([data-line], [data-column-number], [data-gutter-buffer], [data-no-newline]) {
  --diffs-computed-diff-line-bg: light-dark(#e6ffec, #122218);
}
[data-line-type="change-deletion"]:where([data-line], [data-column-number], [data-gutter-buffer], [data-no-newline]) {
  --diffs-computed-diff-line-bg: light-dark(#ffebe9, #261710);
}
[data-indicators="bars"] [data-column-number][data-line-type="change-addition"]::before {
  width: 3px;
  background: rgb(${ADDED} / 0.6);
}
[data-indicators="bars"] [data-column-number][data-line-type="change-deletion"]::before {
  width: 3px;
  background: rgb(${REMOVED} / 0.8);
}
`;
