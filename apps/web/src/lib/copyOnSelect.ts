/**
 * Copy-on-select: the terminal-emulator behavior where finishing a drag that
 * selects text also puts that text on the clipboard.
 *
 * The decision lives here, apart from the DOM listeners in `useCopyOnSelect`,
 * so the rules that matter — what counts as in scope, what is never copied —
 * are testable without a browser.
 */

// Selecting inside a field is part of editing it, not a request to copy.
// Auto-copying there would clobber the clipboard mid-edit, which is exactly
// when a user is most likely to be holding something they mean to paste.
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

// Compared against `nodeType` rather than using `instanceof Element`, which
// needs a DOM global this module must not require: the rules below are
// exercised under the repo's node test environment.
const ELEMENT_NODE = 1;

const elementFor = (node: Node | null): Element | null => {
  if (node === null) return null;
  return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
};

export const isEditableSelectionEndpoint = (node: Node | null): boolean =>
  elementFor(node)?.closest(EDITABLE_SELECTOR) != null;

export interface CopyOnSelectCandidate {
  readonly text: string;
  readonly isCollapsed: boolean;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
}

/**
 * The text a finished selection gesture should copy, or `null` to copy nothing.
 *
 * Both ends of the selection must sit inside `scope`, so a drag that runs out
 * of the transcript copies nothing rather than copying half of it, and neither
 * end may be editable.
 */
export function resolveCopyOnSelectText(
  candidate: CopyOnSelectCandidate | null,
  scope: Element | null,
): string | null {
  if (candidate === null || scope === null) return null;
  if (candidate.isCollapsed) return null;
  // A whitespace-only range is the residue of a sloppy click, never worth
  // overwriting the clipboard for. Text that survives is copied verbatim,
  // indentation included.
  if (candidate.text.trim().length === 0) return null;
  const { anchorNode, focusNode } = candidate;
  if (anchorNode === null || focusNode === null) return null;
  if (!scope.contains(anchorNode) || !scope.contains(focusNode)) return null;
  if (isEditableSelectionEndpoint(anchorNode) || isEditableSelectionEndpoint(focusNode)) {
    return null;
  }
  return candidate.text;
}
