export function getReplyText(
  body: string,
  button: Element,
  selection = window.getSelection()
): string {
  const content = button
    .closest("[data-comment]")
    ?.querySelector("[data-comment-body]");
  if (
    !content ||
    !selection ||
    selection.isCollapsed ||
    !selection.anchorNode ||
    !selection.focusNode ||
    !content.contains(selection.anchorNode) ||
    !content.contains(selection.focusNode)
  ) {
    return body;
  }
  const text = selection.toString();
  return text.trim() ? text : body;
}
